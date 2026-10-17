import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  TASK_OPERATIONS,
  TaskAuthorizationBoundary,
  type TaskAuthorizationResult,
  type TaskOperation,
} from './task-authorization-boundary';

export const TASK_HTTP_AUTHORIZATION_REQUIREMENT = Symbol(
  'TASK_HTTP_AUTHORIZATION_REQUIREMENT',
);
export interface TaskHttpAuthorizationRequirement {
  operation: TaskOperation;
  projectIdParam: string;
  resourceIdParam?: string;
}

export interface TaskHttpRequestBinding {
  method: string;
  target: string;
  projectId: string;
  /** SHA-256 of the original HTTP body bytes, when a body is present. */
  bodySha256?: string;
}

type TaskExpressRequest = Request & { rawBody?: unknown };
type AuthorizedTaskContext = Extract<
  TaskAuthorizationResult,
  { kind: 'authorized' }
>;

const TASK_AUTHORIZED_REQUEST_CONTEXT = Symbol(
  'TASK_AUTHORIZED_REQUEST_CONTEXT',
);

function attachAuthorizedContext(
  request: unknown,
  context: AuthorizedTaskContext,
): boolean {
  try {
    if (typeof request !== 'object' || request === null) return false;
    if (
      Object.getOwnPropertyDescriptor(request, TASK_AUTHORIZED_REQUEST_CONTEXT)
    ) {
      return false;
    }
    Object.defineProperty(request, TASK_AUTHORIZED_REQUEST_CONTEXT, {
      configurable: false,
      enumerable: false,
      value: context,
      writable: false,
    });
    return true;
  } catch {
    return false;
  }
}

/** Read the verifier- and policy-approved context attached by the HTTP guard. */
export function getTaskAuthorizedRequestContext(
  request: unknown,
): AuthorizedTaskContext | undefined {
  try {
    if (typeof request !== 'object' || request === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(
      request,
      TASK_AUTHORIZED_REQUEST_CONTEXT,
    );
    if (!descriptor || !('value' in descriptor)) return undefined;
    const context = descriptor.value as unknown;
    if (
      typeof context !== 'object' ||
      context === null ||
      (context as AuthorizedTaskContext).kind !== 'authorized'
    ) {
      return undefined;
    }
    return context as AuthorizedTaskContext;
  } catch {
    return undefined;
  }
}

export function RequireTaskAuthorization(
  requirement: TaskHttpAuthorizationRequirement,
): MethodDecorator {
  return SetMetadata(TASK_HTTP_AUTHORIZATION_REQUIREMENT, requirement);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return (
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null
  );
}

function parseRequirement(
  value: unknown,
): TaskHttpAuthorizationRequirement | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const keys = Object.keys(value).sort();
    if (
      !keys.includes('operation') ||
      !keys.includes('projectIdParam') ||
      keys.some(
        (key) =>
          key !== 'operation' &&
          key !== 'projectIdParam' &&
          key !== 'resourceIdParam',
      ) ||
      typeof value.operation !== 'string' ||
      !TASK_OPERATIONS.includes(value.operation as TaskOperation) ||
      typeof value.projectIdParam !== 'string' ||
      value.projectIdParam.length === 0 ||
      (value.resourceIdParam !== undefined &&
        (typeof value.resourceIdParam !== 'string' ||
          value.resourceIdParam.length === 0)) ||
      (value.operation === 'detail' && value.resourceIdParam === undefined) ||
      (value.operation !== 'detail' && value.resourceIdParam !== undefined)
    ) {
      return undefined;
    }

    return {
      operation: value.operation as TaskOperation,
      projectIdParam: value.projectIdParam,
      ...(value.resourceIdParam === undefined
        ? {}
        : { resourceIdParam: value.resourceIdParam }),
    };
  } catch {
    return undefined;
  }
}

function readParam(params: unknown, name: string): string | undefined {
  try {
    if (!isRecord(params)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(params, name);
    if (!descriptor || !('value' in descriptor)) return undefined;
    return typeof descriptor.value === 'string' && descriptor.value.length > 0
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function readBearerCredential(headers: unknown): string | undefined {
  try {
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers)
    ) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      headers,
      'authorization',
    );
    if (!descriptor || !('value' in descriptor)) return undefined;
    if (
      typeof descriptor.value !== 'string' ||
      descriptor.value.length > 16_384 ||
      /[\r\n]/.test(descriptor.value)
    ) {
      return undefined;
    }
    const match = /^Bearer ([^\s,]+)$/i.exec(descriptor.value);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function createRequestBinding(
  request: TaskExpressRequest,
  projectId: string,
): TaskHttpRequestBinding | undefined {
  try {
    const method = request.method;
    const target = request.originalUrl || request.url;
    if (
      typeof method !== 'string' ||
      !/^[A-Za-z]+$/.test(method) ||
      typeof target !== 'string' ||
      target.length === 0 ||
      target.length > 8_192 ||
      !target.startsWith('/') ||
      target.startsWith('//') ||
      hasForbiddenTargetCharacters(target)
    ) {
      return undefined;
    }

    const rawBody = request.rawBody;
    if (
      method.toUpperCase() !== 'GET' &&
      method.toUpperCase() !== 'HEAD' &&
      !Buffer.isBuffer(rawBody)
    ) {
      return undefined;
    }

    return {
      method: method.toUpperCase(),
      target,
      projectId,
      ...(Buffer.isBuffer(rawBody)
        ? {
            bodySha256: createHash('sha256')
              .update(rawBody)
              .digest('base64url'),
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function hasForbiddenTargetCharacters(target: string): boolean {
  for (const character of target) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      character === '#'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Inert unless attached to an explicitly declared handler. It treats the
 * Authorization credential as an opaque verifier input; it does not select a
 * token profile, establish service identity, or map public rejection errors.
 * Non-GET/HEAD handlers require Nest raw-body capture so the verifier can bind
 * the original body bytes. No handler is registered by TaskRuntimeModule.
 */
@Injectable()
export class TaskAuthorizationHttpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorizationBoundary: TaskAuthorizationBoundary,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    let requirement: TaskHttpAuthorizationRequirement | undefined;
    let request: TaskExpressRequest;
    try {
      requirement = parseRequirement(
        this.reflector.getAllAndOverride(TASK_HTTP_AUTHORIZATION_REQUIREMENT, [
          context.getHandler(),
          context.getClass(),
        ]),
      );
      request = context.switchToHttp().getRequest<TaskExpressRequest>();
    } catch {
      return false;
    }
    if (!requirement) return false;

    const projectId = readParam(request.params, requirement.projectIdParam);
    const contextCandidate = readBearerCredential(request.headers);
    if (!projectId || !contextCandidate) return false;

    const resourceId =
      requirement.operation === 'detail'
        ? readParam(request.params, requirement.resourceIdParam!)
        : undefined;
    if (requirement.operation === 'detail' && !resourceId) return false;

    const requestBinding = createRequestBinding(request, projectId);
    if (!requestBinding) return false;

    try {
      const result = await this.authorizationBoundary.authorize({
        operation: requirement.operation,
        contextCandidate,
        requestBinding,
        requestedProjectId: projectId,
        ...(resourceId === undefined ? {} : { resourceId }),
      });
      return (
        result.kind === 'authorized' && attachAuthorizedContext(request, result)
      );
    } catch {
      return false;
    }
  }
}
