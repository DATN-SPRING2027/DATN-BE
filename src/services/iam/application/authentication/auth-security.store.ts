export const AUTH_SECURITY_STORE = Symbol('AUTH_SECURITY_STORE');

export interface AuthSecurityStore {
  consumeRateLimit(
    this: void,
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean>;
  isRateLimited?(this: void, key: string, limit: number): Promise<boolean>;
  clearRateLimit(key: string): Promise<void>;
  revokeToken(tokenHash: string, ttlSeconds: number): Promise<void>;
  isTokenRevoked(tokenHash: string): Promise<boolean>;
  storeOneTimeToken?(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void>;
  consumeOneTimeToken?(key: string): Promise<string | null>;
}
