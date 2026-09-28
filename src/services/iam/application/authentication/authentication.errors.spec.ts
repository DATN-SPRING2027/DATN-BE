import {
  AuthenticationError,
  mapAuthenticationError,
} from './authentication.errors';

describe('mapAuthenticationError', () => {
  it('maps invalid credentials and invalid tokens to the same generic result', () => {
    expect(
      mapAuthenticationError(new AuthenticationError('INVALID_CREDENTIALS')),
    ).toEqual({
      code: 'AUTHENTICATION_FAILED',
      message: 'Authentication failed.',
    });
    expect(
      mapAuthenticationError(new AuthenticationError('INVALID_TOKEN')),
    ).toEqual({
      code: 'AUTHENTICATION_FAILED',
      message: 'Authentication failed.',
    });
  });

  it('preserves decision-required gates without adding HTTP status semantics', () => {
    expect(
      mapAuthenticationError(
        new AuthenticationError('DECISION_REQUIRED', ['G-04', 'G-01', 'G-02']),
      ),
    ).toEqual({
      code: 'DECISION_REQUIRED',
      message: 'Authentication requires unresolved policy decisions.',
      gates: ['G-04', 'G-01', 'G-02'],
    });
  });

  it('does not leak arbitrary error details', () => {
    expect(
      mapAuthenticationError(new Error('password or token value')),
    ).toEqual({
      code: 'AUTHENTICATION_UNAVAILABLE',
      message: 'Authentication could not be completed.',
    });
  });
});
