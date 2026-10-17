import { Injectable } from '@nestjs/common';
import type {
  EmailRegistrationEmailPayload,
  EmailRegistrationEmailPayloadBinding,
  EmailRegistrationOutboxStore,
  EmailRegistrationTokenClaim,
} from '../../application/authentication/email-registration.store';

@Injectable()
export class UnavailableEmailRegistrationOutboxStore implements EmailRegistrationOutboxStore {
  private unavailable(): never {
    throw new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE');
  }

  assertReady(): Promise<void> {
    return Promise.reject(new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE'));
  }

  saveEmailRegistrationRequest(): Promise<boolean> {
    return Promise.reject(new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE'));
  }

  claimEmailRegistrationToken(): Promise<EmailRegistrationTokenClaim | null> {
    return Promise.reject(new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE'));
  }

  completeClaimedEmailRegistration(): Promise<boolean> {
    return Promise.reject(new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE'));
  }

  releaseEmailRegistrationTokenClaim(): Promise<void> {
    return Promise.reject(new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE'));
  }

  claimNextEmailRegistrationEmail(): Promise<null> {
    return Promise.reject(new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE'));
  }

  failExhaustedEmailRegistrationEmails(): Promise<void> {
    return Promise.reject(new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE'));
  }

  markEmailRegistrationEmailSent(): Promise<boolean> {
    return Promise.reject(new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE'));
  }

  retryEmailRegistrationEmail(): Promise<'STALE'> {
    return Promise.reject(new Error('EMAIL_REGISTRATION_OUTBOX_UNAVAILABLE'));
  }

  decryptEmailRegistrationPayload(
    _encryptedPayload: string,
    _binding: EmailRegistrationEmailPayloadBinding,
  ): EmailRegistrationEmailPayload {
    void _encryptedPayload;
    void _binding;
    return this.unavailable();
  }
}
