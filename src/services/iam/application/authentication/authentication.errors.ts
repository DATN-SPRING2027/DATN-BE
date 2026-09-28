export type AuthenticationErrorCode =
  'INVALID_CREDENTIALS' | 'INVALID_TOKEN' | 'DECISION_REQUIRED';

export class AuthenticationError extends Error {
  constructor(
    readonly code: AuthenticationErrorCode,
    readonly gates: readonly string[] = [],
  ) {
    super(
      code === 'DECISION_REQUIRED'
        ? 'Authentication decision required'
        : 'Authentication failed',
    );
    this.name = AuthenticationError.name;
  }
}

export type AuthenticationErrorMapping =
  | { code: 'AUTHENTICATION_FAILED'; message: 'Authentication failed.' }
  | {
      code: 'DECISION_REQUIRED';
      message: 'Authentication requires unresolved policy decisions.';
      gates: readonly string[];
    }
  | {
      code: 'AUTHENTICATION_UNAVAILABLE';
      message: 'Authentication could not be completed.';
    };

/** Maps failures to an internal safe descriptor, not an HTTP response contract. */
export function mapAuthenticationError(
  error: unknown,
): AuthenticationErrorMapping {
  if (!(error instanceof AuthenticationError)) {
    return {
      code: 'AUTHENTICATION_UNAVAILABLE',
      message: 'Authentication could not be completed.',
    };
  }

  if (error.code === 'DECISION_REQUIRED') {
    return {
      code: 'DECISION_REQUIRED',
      message: 'Authentication requires unresolved policy decisions.',
      gates: [...error.gates],
    };
  }

  return { code: 'AUTHENTICATION_FAILED', message: 'Authentication failed.' };
}
