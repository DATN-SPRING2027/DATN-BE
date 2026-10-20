import { HttpException } from '@nestjs/common';
import type { TaskAuthorizationDenialReason } from './task-authorization-boundary';
import {
  TASK_AUTHORIZATION_DENIAL_HTTP,
  taskAuthorizationDeniedException,
} from './task-authorization-http.errors';

const expectedMapping: Record<
  TaskAuthorizationDenialReason,
  { status: number; code: string }
> = {
  UNVERIFIED_CONTEXT: { status: 401, code: 'TASK_UNAUTHENTICATED' },
  CONTEXT_VERIFIER_UNAVAILABLE: {
    status: 503,
    code: 'TASK_AUTHORIZATION_UNAVAILABLE',
  },
  INVALID_REQUEST: { status: 500, code: 'HTTP_500' },
  PROJECT_MISMATCH: { status: 404, code: 'TASK_NOT_FOUND' },
  RESOURCE_SCOPE_UNRESOLVED: { status: 404, code: 'TASK_NOT_FOUND' },
  RESOURCE_SCOPE_MISMATCH: { status: 404, code: 'TASK_NOT_FOUND' },
  PROJECT_SCOPE_DENIED: { status: 404, code: 'TASK_NOT_FOUND' },
  PERMISSION_DENIED: { status: 404, code: 'TASK_NOT_FOUND' },
  PROJECT_SCOPE_UNAVAILABLE: {
    status: 503,
    code: 'TASK_AUTHORIZATION_UNAVAILABLE',
  },
  PERMISSION_POLICY_UNAVAILABLE: {
    status: 503,
    code: 'TASK_AUTHORIZATION_UNAVAILABLE',
  },
  RESOURCE_SCOPE_UNAVAILABLE: {
    status: 503,
    code: 'TASK_AUTHORIZATION_UNAVAILABLE',
  },
};

describe('Task authorization denial to HTTP mapping (ERR-1, ERR-2)', () => {
  it('answers a generic 500 only for INVALID_REQUEST, a server fault that is never a 404', () => {
    const faults = Object.entries(TASK_AUTHORIZATION_DENIAL_HTTP)
      .filter(([, outcome]) => outcome === 'INTERNAL')
      .map(([reason]) => reason);
    expect(faults).toEqual(['INVALID_REQUEST']);
    const exception = taskAuthorizationDeniedException('INVALID_REQUEST');
    expect(exception.getStatus()).toBe(500);
    expect(exception.getResponse()).toEqual({
      code: 'HTTP_500',
      message: 'Internal server error',
    });
  });

  it('covers every denial reason, with no generic 403', () => {
    expect(Object.keys(TASK_AUTHORIZATION_DENIAL_HTTP).sort()).toEqual(
      Object.keys(expectedMapping).sort(),
    );
    for (const reason of Object.keys(expectedMapping)) {
      const exception = taskAuthorizationDeniedException(
        reason as TaskAuthorizationDenialReason,
      );
      expect(exception.getStatus()).not.toBe(403);
    }
  });

  it.each(Object.entries(expectedMapping))(
    'maps %s to its status and TASK_* code without leaking the reason',
    (reason, expected) => {
      const exception: HttpException = taskAuthorizationDeniedException(
        reason as TaskAuthorizationDenialReason,
      );
      expect(exception.getStatus()).toBe(expected.status);
      const body = exception.getResponse() as Record<string, unknown>;
      expect(body.code).toBe(expected.code);
      expect(JSON.stringify(body)).not.toContain(reason);
    },
  );
});
