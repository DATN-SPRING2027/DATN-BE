export const PASSWORD_RESET_TOKEN_STORE = Symbol('PASSWORD_RESET_TOKEN_STORE');

export interface PasswordResetTokenClaim {
  userScopeHash: string;
  userId: string;
}

export interface PasswordResetTokenStore {
  savePasswordResetToken(
    this: void,
    userScopeHash: string,
    tokenHash: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  claimPasswordResetToken(
    this: void,
    tokenHash: string,
    claimId: string,
  ): Promise<PasswordResetTokenClaim | null>;
  consumeClaimedPasswordResetToken(
    this: void,
    tokenHash: string,
    userScopeHash: string,
    claimId: string,
  ): Promise<boolean>;
  releasePasswordResetTokenClaim(
    this: void,
    userScopeHash: string,
    claimId: string,
  ): Promise<void>;
  discardPasswordResetToken(
    this: void,
    userScopeHash: string,
    tokenHash: string,
  ): Promise<void>;
}
