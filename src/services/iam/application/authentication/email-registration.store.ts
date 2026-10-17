export const EMAIL_REGISTRATION_OUTBOX = Symbol('EMAIL_REGISTRATION_OUTBOX');

export interface EmailRegistrationEmailPayload {
  recipientEmail: string;
  verificationUrl: string;
}

export interface EmailRegistrationEmailPayloadBinding {
  normalizedEmail: string;
  tokenHash: string;
}

export interface EmailRegistrationEmailJob {
  normalizedEmail: string;
  tokenHash: string;
  leaseId: string;
  attemptCount: number;
  encryptedPayload: string;
}

export interface EmailRegistrationTokenClaim {
  normalizedEmail: string;
  fullName: string;
  tokenHash: string;
  claimId: string;
}

export interface EmailRegistrationOutboxStore {
  assertReady(this: void): Promise<void>;
  saveEmailRegistrationRequest(
    this: void,
    input: {
      normalizedEmail: string;
      fullName: string;
      tokenHash: string;
      expiresAt: Date;
      payload?: EmailRegistrationEmailPayload;
    },
  ): Promise<boolean>;
  claimEmailRegistrationToken(
    this: void,
    tokenHash: string,
    claimId: string,
    now: Date,
    claimUntil: Date,
  ): Promise<EmailRegistrationTokenClaim | null>;
  completeClaimedEmailRegistration(
    this: void,
    claim: EmailRegistrationTokenClaim,
    passwordHash: string,
    now: Date,
  ): Promise<boolean>;
  releaseEmailRegistrationTokenClaim(
    this: void,
    normalizedEmail: string,
    claimId: string,
  ): Promise<void>;
  claimNextEmailRegistrationEmail(
    this: void,
    now: Date,
    leaseId: string,
    leaseUntil: Date,
  ): Promise<EmailRegistrationEmailJob | null>;
  failExhaustedEmailRegistrationEmails(
    this: void,
    now: Date,
    maxAttempts: number,
    safeErrorCode: string,
  ): Promise<void>;
  markEmailRegistrationEmailSent(
    this: void,
    tokenHash: string,
    leaseId: string,
    sentAt: Date,
  ): Promise<boolean>;
  retryEmailRegistrationEmail(
    this: void,
    tokenHash: string,
    leaseId: string,
    nextAttemptAt: Date,
    maxAttempts: number,
    safeErrorCode: string,
  ): Promise<'REQUEUED' | 'FAILED' | 'STALE'>;
  decryptEmailRegistrationPayload(
    this: void,
    encryptedPayload: string,
    binding: EmailRegistrationEmailPayloadBinding,
  ): EmailRegistrationEmailPayload;
}
