import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
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
import {
  taskAuthorizationDeniedException,
  taskAuthorizationUnavailableException,
  taskNotFoundException,
  taskUnauthenticatedException,
} from './task-authorization-http.errors';

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
  /** SHA-256 of the original HTTP body bytes, including a zero-length body. */
  bodySha256?: string;
}

type TaskExpressRequest = Request & { rawBody?: unknown };
type RequestBindingResult =
  | { kind: 'bound'; binding: TaskHttpRequestBinding }
  | { kind: 'invalid' }
  | { kind: 'body-unavailable' };
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
      ((value.operation === 'detail' || value.operation === 'history') &&
        value.resourceIdParam === undefined) ||
      (value.operation !== 'detail' &&
        value.operation !== 'history' &&
        value.resourceIdParam !== undefined)
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
): RequestBindingResult {
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
      return { kind: 'invalid' };
    }

    let rawBody = Buffer.isBuffer(request.rawBody)
      ? request.rawBody
      : undefined;
    if (
      method.toUpperCase() !== 'GET' &&
      method.toUpperCase() !== 'HEAD' &&
      rawBody === undefined
    ) {
      if (!hasNoRequestBody(request)) return { kind: 'body-unavailable' };
      rawBody = Buffer.alloc(0);
    }

    return {
      kind: 'bound',
      binding: {
        method: method.toUpperCase(),
        target,
        projectId,
        ...(rawBody !== undefined
          ? {
              bodySha256: createHash('sha256')
                .update(rawBody)
                .digest('base64url'),
            }
          : {}),
      },
    };
  } catch {
    return { kind: 'invalid' };
  }
}

/** A missing raw body is an empty body only when HTTP framing proves it. */
function hasNoRequestBody(request: TaskExpressRequest): boolean {
  const headers = request.headers as unknown;
  if (
    typeof headers !== 'object' ||
    headers === null ||
    Array.isArray(headers)
  ) {
    return false;
  }

  const contentLength = Object.getOwnPropertyDescriptor(
    headers,
    'content-length',
  );
  const transferEncoding = Object.getOwnPropertyDescriptor(
    headers,
    'transfer-encoding',
  );
  if (transferEncoding !== undefined) return false;
  if (contentLength === undefined) return true;
  return (
    'value' in contentLength &&
    typeof contentLength.value === 'string' &&
    /^0+$/.test(contentLength.value)
  );
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
 * token profile or establish service identity. A rejected request is answered
 * with the ERR-1/ERR-2 outcome for its reason: 401 for a missing or unverified
 * credential, 404 for a request that must not reveal existence, 503 when
 * authorization cannot be evaluated, and a generic 500 when the internal
 * authorization request is malformed (logged, never echoed). It never answers
 * a generic 403.
 * Non-GET/HEAD handlers require Nest raw-body capture for a body-bearing
 * request; otherwise HTTP framing must prove the body is empty. No handler is
 * registered by TaskRuntimeModule unless the explicit Task routes flag is on.
 */
@Injectable()
export class TaskAuthorizationHttpGuard implements CanActivate {
  private readonly logger = new Logger(TaskAuthorizationHttpGuard.name);

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
      throw taskAuthorizationUnavailableException();
    }
    // A handler that is not declared correctly fails closed as unavailable.
    if (!requirement) throw taskAuthorizationUnavailableException();

    const contextCandidate = readBearerCredential(request.headers);
    if (!contextCandidate) throw taskUnauthenticatedException();
    const projectId = readParam(request.params, requirement.projectIdParam);
    if (!projectId) throw taskNotFoundException();

    const resourceId =
      requirement.operation === 'detail' || requirement.operation === 'history'
        ? readParam(request.params, requirement.resourceIdParam!)
        : undefined;
    if (
      (requirement.operation === 'detail' ||
        requirement.operation === 'history') &&
      !resourceId
    ) {
      throw taskNotFoundException();
    }

    const bindingResult = createRequestBinding(request, projectId);
    if (bindingResult.kind === 'body-unavailable') {
      throw taskAuthorizationUnavailableException();
    }
    if (bindingResult.kind === 'invalid') throw taskNotFoundException();
    const requestBinding = bindingResult.binding;

    let result: TaskAuthorizationResult;
    try {
      result = await this.authorizationBoundary.authorize({
        operation: requirement.operation,
        contextCandidate,
        requestBinding,
        requestedProjectId: projectId,
        ...(resourceId === undefined ? {} : { resourceId }),
      });
    } catch {
      throw taskAuthorizationUnavailableException();
    }
    if (result.kind !== 'authorized') {
      if (result.reason === 'INVALID_REQUEST') {
        // ERR-2: a server fault. Only the reason is logged, never request data.
        this.logger.error(
          'Task authorization request was malformed (INVALID_REQUEST)',
        );
      }
      throw taskAuthorizationDeniedException(result.reason);
    }
    if (!attachAuthorizedContext(request, result)) {
      throw taskAuthorizationUnavailableException();
    }
    return true;
  }
}
