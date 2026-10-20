import {
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { TaskAuthorizationDenialReason } from './task-authorization-boundary';

type TaskAuthorizationHttpOutcome =
  'UNAUTHENTICATED' | 'NOT_FOUND' | 'UNAVAILABLE' | 'INTERNAL';

/**
 * ERR-1 and ERR-2 (DATN-97 OpenAPI): every denial reason maps to 401, 404 or 503,
 * except INVALID_REQUEST, a malformed internal authorization request, which is a
 * server fault and answers a generic 500. There is no generic 403. A `Record`
 * keeps the mapping exhaustive when a reason is added.
 */
export const TASK_AUTHORIZATION_DENIAL_HTTP: Record<
  TaskAuthorizationDenialReason,
  TaskAuthorizationHttpOutcome
> = {
  UNVERIFIED_CONTEXT: 'UNAUTHENTICATED',
  CONTEXT_VERIFIER_UNAVAILABLE: 'UNAVAILABLE',
  INVALID_REQUEST: 'INTERNAL',
  PROJECT_MISMATCH: 'NOT_FOUND',
  RESOURCE_SCOPE_UNRESOLVED: 'NOT_FOUND',
  RESOURCE_SCOPE_MISMATCH: 'NOT_FOUND',
  PROJECT_SCOPE_DENIED: 'NOT_FOUND',
  PERMISSION_DENIED: 'NOT_FOUND',
  PROJECT_SCOPE_UNAVAILABLE: 'UNAVAILABLE',
  PERMISSION_POLICY_UNAVAILABLE: 'UNAVAILABLE',
  RESOURCE_SCOPE_UNAVAILABLE: 'UNAVAILABLE',
};

export function taskUnauthenticatedException(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'TASK_UNAUTHENTICATED',
    message: 'Authentication is missing or invalid',
  });
}

export function taskNotFoundException(): NotFoundException {
  return new NotFoundException({
    code: 'TASK_NOT_FOUND',
    message: 'Task not found',
  });
}

export function taskAuthorizationUnavailableException(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'TASK_AUTHORIZATION_UNAVAILABLE',
    message: 'Authorization is temporarily unavailable',
  });
}

/** A server fault: the cause is logged internally and never sent to the caller. */
export function taskInternalErrorException(): InternalServerErrorException {
  return new InternalServerErrorException({
    code: 'HTTP_500',
    message: 'Internal server error',
  });
}

/** The reason is never echoed to the caller. */
export function taskAuthorizationDeniedException(
  reason: TaskAuthorizationDenialReason,
): HttpException {
  switch (TASK_AUTHORIZATION_DENIAL_HTTP[reason]) {
    case 'UNAUTHENTICATED':
      return taskUnauthenticatedException();
    case 'NOT_FOUND':
      return taskNotFoundException();
    case 'INTERNAL':
      return taskInternalErrorException();
    default:
      return taskAuthorizationUnavailableException();
  }
}
