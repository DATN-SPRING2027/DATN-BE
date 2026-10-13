export const PASSWORD_RESET_TOKEN_STORE = Symbol('PASSWORD_RESET_TOKEN_STORE');

export interface PasswordResetTokenStore {
  savePasswordResetToken(
    this: void,
    userScopeHash: string,
    tokenHash: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<void>;
  consumePasswordResetToken(
    this: void,
    tokenHash: string,
  ): Promise<string | null>;
  discardPasswordResetToken(
    this: void,
    userScopeHash: string,
    tokenHash: string,
  ): Promise<void>;
}
