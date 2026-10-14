import { Injectable } from '@nestjs/common';
import type {
  PasswordResetEmailJob,
  PasswordResetEmailPayload,
  PasswordResetRequestSaveResult,
  PasswordResetOutboxStore,
  PasswordResetTokenClaim,
} from '../../application/authentication/password-reset.store';

@Injectable()
export class UnavailablePasswordResetOutboxStore implements PasswordResetOutboxStore {
  assertReady(): Promise<void> {
    return Promise.reject(new Error('PASSWORD_RESET_OUTBOX_UNAVAILABLE'));
  }

  savePasswordResetRequest(): Promise<PasswordResetRequestSaveResult> {
    return Promise.reject(new Error('PASSWORD_RESET_OUTBOX_UNAVAILABLE'));
  }

  claimPasswordResetToken(): Promise<PasswordResetTokenClaim | null> {
    return Promise.resolve(null);
  }

  consumeClaimedPasswordResetToken(): Promise<boolean> {
    return Promise.resolve(false);
  }

  releasePasswordResetTokenClaim(): Promise<void> {
    return Promise.resolve();
  }

  claimNextPasswordResetEmail(): Promise<PasswordResetEmailJob | null> {
    return Promise.resolve(null);
  }

  failExhaustedPasswordResetEmails(): Promise<void> {
    return Promise.resolve();
  }

  markPasswordResetEmailSent(): Promise<boolean> {
    return Promise.resolve(false);
  }

  retryPasswordResetEmail(): Promise<'STALE'> {
    return Promise.resolve('STALE');
  }

  decryptPasswordResetEmailPayload(): PasswordResetEmailPayload {
    throw new Error('PASSWORD_RESET_OUTBOX_UNAVAILABLE');
  }
}
