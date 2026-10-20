import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import {
  AUTHENTICATION_REPOSITORY,
  type AuthenticationRepositoryPort,
} from './authentication.repository';
import {
  AUTH_SECURITY_STORE,
  type AuthSecurityStore,
} from './auth-security.store';
import {
  EMAIL_REGISTRATION_OUTBOX,
  type EmailRegistrationOutboxStore,
  type EmailRegistrationTokenClaim,
} from './email-registration.store';
import { PasswordCredentialService } from '../credentials/password-credential.service';

const TOKEN_TTL_SECONDS = 30 * 60;
const SOURCE_LIMIT = 20;
const EMAIL_LIMIT = 3;
const RATE_WINDOW_SECONDS = 15 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PASSWORD_UTF8_BYTES = 72;
const MIN_PASSWORD_CHARACTERS = 12;
const TOKEN_CLAIM_MILLISECONDS = 2 * 60 * 1000;

export class EmailRegistrationRateLimitError extends Error {
  constructor() {
    super('Email registration rate limit exceeded');
    this.name = EmailRegistrationRateLimitError.name;
  }
}

export class EmailRegistrationInvalidTokenError extends Error {
  constructor() {
    super('Email registration token is invalid');
    this.name = EmailRegistrationInvalidTokenError.name;
  }
}

export class EmailRegistrationPasswordPolicyError extends Error {
  constructor() {
    super('Password does not meet the credential storage limit');
    this.name = EmailRegistrationPasswordPolicyError.name;
  }
}

export class EmailRegistrationRequestUnavailableError extends Error {
  constructor() {
    super('Email registration request could not be durably queued');
    this.name = EmailRegistrationRequestUnavailableError.name;
  }
}

export class EmailRegistrationVerificationUnavailableError extends Error {
  constructor() {
    super('Email registration verification is temporarily unavailable');
    this.name = EmailRegistrationVerificationUnavailableError.name;
  }
}

export interface RequestEmailRegistrationInput {
  fullName: string;
  email: string;
  sourceIp: string;
  returnToInvitationId?: string;
}

export interface CompleteEmailRegistrationInput {
  token: string;
  password: string;
  sourceIp: string;
}

@Injectable()
export class EmailRegistrationService {
  private readonly logger = new Logger(EmailRegistrationService.name);

  constructor(
    @Inject(AUTHENTICATION_REPOSITORY)
    private readonly repository: AuthenticationRepositoryPort,
    @Inject(AUTH_SECURITY_STORE)
    private readonly security: AuthSecurityStore,
    @Inject(EMAIL_REGISTRATION_OUTBOX)
    private readonly outbox: EmailRegistrationOutboxStore,
    private readonly credentials: PasswordCredentialService,
    private readonly config: ConfigService,
  ) {}

  async requestRegistration(
    input: RequestEmailRegistrationInput,
  ): Promise<{ status: 'accepted' }> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const emailDigest = digest(normalizedEmail);
    const sourceDigest = digest(input.sourceIp || 'unknown');

    try {
      const sourceAllowed = await this.security.consumeRateLimit(
        `auth:email-registration:source:${sourceDigest}`,
        SOURCE_LIMIT,
        RATE_WINDOW_SECONDS,
      );
      const emailAllowed = sourceAllowed
        ? await this.security.consumeRateLimit(
            `auth:email-registration:email:${emailDigest}`,
            EMAIL_LIMIT,
            RATE_WINDOW_SECONDS,
          )
        : false;
      if (!sourceAllowed || !emailAllowed)
        throw new EmailRegistrationRateLimitError();
    } catch (error) {
      if (error instanceof EmailRegistrationRateLimitError) throw error;
      this.logger.warn('email_registration_request_unavailable');
      throw new EmailRegistrationRequestUnavailableError();
    }

    try {
      await this.outbox.assertReady();
      this.createVerificationUrl('A'.repeat(43), input.returnToInvitationId);
    } catch {
      this.logger.warn('email_registration_request_unavailable');
      throw new EmailRegistrationRequestUnavailableError();
    }

    let account: Awaited<
      ReturnType<AuthenticationRepositoryPort['findAccountByEmail']>
    >;
    try {
      account = await this.repository.findAccountByEmail(normalizedEmail);
    } catch {
      this.logger.warn('email_registration_request_unavailable');
      throw new EmailRegistrationRequestUnavailableError();
    }

    const isEligibleGoogleOnlyAccount =
      account?.status === 'ACTIVE' &&
      Boolean(account.googleSubject) &&
      !account.passwordHash;
    const eligible = !account || isEligibleGoogleOnlyAccount;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = digest(token);
    try {
      const saved = await this.outbox.saveEmailRegistrationRequest({
        normalizedEmail,
        fullName: input.fullName.trim(),
        tokenHash,
        expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
        ...(eligible
          ? {
              payload: {
                recipientEmail: normalizedEmail,
                verificationUrl: this.createVerificationUrl(
                  token,
                  input.returnToInvitationId,
                ),
              },
            }
          : {}),
      });
      if (!saved)
        throw new Error('EMAIL_REGISTRATION_OUTBOX_WRITE_NOT_APPLIED');
    } catch {
      this.logger.warn('email_registration_request_unavailable');
      throw new EmailRegistrationRequestUnavailableError();
    }

    return { status: 'accepted' };
  }

  async completeRegistration(
    input: CompleteEmailRegistrationInput,
  ): Promise<void> {
    if (
      Array.from(input.password).length < MIN_PASSWORD_CHARACTERS ||
      Array.from(input.password).length > 72 ||
      Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_UTF8_BYTES
    ) {
      throw new EmailRegistrationPasswordPolicyError();
    }

    try {
      const sourceDigest = digest(input.sourceIp || 'unknown');
      if (
        !(await this.security.consumeRateLimit(
          `auth:email-registration:verify:${sourceDigest}`,
          SOURCE_LIMIT,
          RATE_WINDOW_SECONDS,
        ))
      ) {
        throw new EmailRegistrationRateLimitError();
      }
    } catch (error) {
      if (error instanceof EmailRegistrationRateLimitError) throw error;
      this.logger.warn('email_registration_verification_unavailable');
      throw new EmailRegistrationVerificationUnavailableError();
    }

    if (!TOKEN_PATTERN.test(input.token))
      throw new EmailRegistrationInvalidTokenError();

    try {
      await this.outbox.assertReady();
    } catch {
      this.logger.warn('email_registration_verification_unavailable');
      throw new EmailRegistrationVerificationUnavailableError();
    }

    const tokenHash = digest(input.token);
    const claimId = randomBytes(32).toString('base64url');
    let claim: EmailRegistrationTokenClaim | null;
    try {
      claim = await this.outbox.claimEmailRegistrationToken(
        tokenHash,
        claimId,
        new Date(),
        new Date(Date.now() + TOKEN_CLAIM_MILLISECONDS),
      );
    } catch {
      this.logger.warn('email_registration_verification_unavailable');
      throw new EmailRegistrationVerificationUnavailableError();
    }
    if (!claim) throw new EmailRegistrationInvalidTokenError();

    try {
      const passwordHash = await this.credentials.hashPassword(input.password);
      const completed = await this.outbox.completeClaimedEmailRegistration(
        claim,
        passwordHash,
        new Date(),
      );
      if (completed === 'INVALID')
        throw new EmailRegistrationInvalidTokenError();
      if (completed === 'RETRYABLE')
        throw new EmailRegistrationVerificationUnavailableError();
    } catch (error) {
      if (error instanceof EmailRegistrationInvalidTokenError) throw error;
      try {
        await this.outbox.releaseEmailRegistrationTokenClaim(
          claim.normalizedEmail,
          claimId,
        );
      } catch {
        this.logger.warn('email_registration_token_claim_release_failed');
      }
      this.logger.warn('email_registration_verification_unavailable');
      throw new EmailRegistrationVerificationUnavailableError();
    }
  }

  private createVerificationUrl(
    token: string,
    returnToInvitationId?: string,
  ): string {
    const configuredUrl = this.config.get<string>('WEB_APP_URL');
    const webAppUrl =
      configuredUrl ||
      (this.config.get<string>('NODE_ENV') === 'production'
        ? ''
        : 'http://localhost:3000');
    if (!webAppUrl) throw new Error('WEB_APP_URL is required in production');

    const baseUrl = new URL(webAppUrl);
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost')
      throw new Error('WEB_APP_URL must use HTTPS outside localhost');

    const verificationUrl = new URL('/verify-email', baseUrl);
    if (returnToInvitationId) {
      if (!/^[a-f\d]{24}$/i.test(returnToInvitationId))
        throw new Error('returnToInvitationId is invalid');
      verificationUrl.searchParams.set(
        'returnToInvitationId',
        returnToInvitationId,
      );
    }
    verificationUrl.hash = new URLSearchParams({ token }).toString();
    return verificationUrl.toString();
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
