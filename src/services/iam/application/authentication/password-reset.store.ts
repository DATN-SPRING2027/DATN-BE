export const PASSWORD_RESET_OUTBOX = Symbol('PASSWORD_RESET_OUTBOX');

export interface PasswordResetTokenClaim {
  userScopeHash: string;
  userId: string;
}

export interface PasswordResetEmailPayload {
  recipientEmail: string;
  resetUrl: string;
}

export interface PasswordResetEmailJob {
  userScopeHash: string;
  userId: string;
  tokenHash: string;
  leaseId: string;
  attemptCount: number;
  encryptedPayload: string;
}

export interface PasswordResetEmailPayloadBinding {
  userScopeHash: string;
  userId: string;
  tokenHash: string;
}

export type PasswordResetRequestSaveResult =
  'SAVED' | 'COALESCED' | 'NOT_SAVED';

export interface PasswordResetOutboxStore {
  assertReady(this: void): Promise<void>;
  savePasswordResetRequest(
    this: void,
    input: {
      userScopeHash: string;
      tokenHash: string;
      userId: string;
      expiresAt: Date;
      payload?: PasswordResetEmailPayload;
    },
  ): Promise<PasswordResetRequestSaveResult>;
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
  claimNextPasswordResetEmail(
    this: void,
    now: Date,
    leaseId: string,
    leaseUntil: Date,
  ): Promise<PasswordResetEmailJob | null>;
  failExhaustedPasswordResetEmails(
    this: void,
    now: Date,
    maxAttempts: number,
    safeErrorCode: string,
  ): Promise<void>;
  markPasswordResetEmailSent(
    this: void,
    tokenHash: string,
    leaseId: string,
    sentAt: Date,
  ): Promise<boolean>;
  retryPasswordResetEmail(
    this: void,
    tokenHash: string,
    leaseId: string,
    nextAttemptAt: Date,
    maxAttempts: number,
    safeErrorCode: string,
  ): Promise<'REQUEUED' | 'FAILED' | 'STALE'>;
  decryptPasswordResetEmailPayload(
    this: void,
    encryptedPayload: string,
    binding: PasswordResetEmailPayloadBinding,
  ): PasswordResetEmailPayload;
}
