export const AUTH_SECURITY_STORE = Symbol('AUTH_SECURITY_STORE');

export interface AuthSecurityStore {
  consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean>;
  clearRateLimit(key: string): Promise<void>;
  revokeToken(tokenHash: string, ttlSeconds: number): Promise<void>;
  isTokenRevoked(tokenHash: string): Promise<boolean>;
}
