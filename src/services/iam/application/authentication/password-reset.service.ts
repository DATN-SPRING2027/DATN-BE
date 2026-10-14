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
  PASSWORD_RESET_OUTBOX,
  type PasswordResetOutboxStore,
} from './password-reset.store';
import { PasswordCredentialService } from '../credentials/password-credential.service';

const RESET_TOKEN_TTL_SECONDS = 30 * 60;
const RESET_SOURCE_LIMIT = 20;
const RESET_EMAIL_LIMIT = 3;
const RESET_RATE_WINDOW_SECONDS = 15 * 60;
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PASSWORD_UTF8_BYTES = 72;
const MIN_PASSWORD_CHARACTERS = 12;

export class PasswordResetRateLimitError extends Error {
  constructor() {
    super('Password reset rate limit exceeded');
    this.name = PasswordResetRateLimitError.name;
  }
}

export class PasswordResetInvalidTokenError extends Error {
  constructor() {
    super('Password reset token is invalid');
    this.name = PasswordResetInvalidTokenError.name;
  }
}

export class PasswordResetPasswordPolicyError extends Error {
  constructor() {
    super('Password does not meet the credential storage limit');
    this.name = PasswordResetPasswordPolicyError.name;
  }
}

export class PasswordResetRequestUnavailableError extends Error {
  constructor() {
    super('Password reset request could not be durably queued');
    this.name = PasswordResetRequestUnavailableError.name;
  }
}

export interface RequestPasswordResetInput {
  email: string;
  sourceIp: string;
}

export interface CompletePasswordResetInput {
  token: string;
  password: string;
  sourceIp: string;
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(AUTHENTICATION_REPOSITORY)
    private readonly repository: AuthenticationRepositoryPort,
    @Inject(AUTH_SECURITY_STORE)
    private readonly security: AuthSecurityStore,
    @Inject(PASSWORD_RESET_OUTBOX)
    private readonly outbox: PasswordResetOutboxStore,
    private readonly credentials: PasswordCredentialService,
    private readonly config: ConfigService,
  ) {}

  async requestReset(
    input: RequestPasswordResetInput,
  ): Promise<{ status: 'accepted' }> {
    const email = input.email.trim().toLowerCase();
    const emailDigest = digest(email);
    const sourceDigest = digest(input.sourceIp || 'unknown');

    try {
      const sourceAllowed = await this.security.consumeRateLimit(
        `auth:password-reset:source:${sourceDigest}`,
        RESET_SOURCE_LIMIT,
        RESET_RATE_WINDOW_SECONDS,
      );
      const emailAllowed = sourceAllowed
        ? await this.security.consumeRateLimit(
            `auth:password-reset:email:${emailDigest}`,
            RESET_EMAIL_LIMIT,
            RESET_RATE_WINDOW_SECONDS,
          )
        : false;
      if (!sourceAllowed || !emailAllowed)
        throw new PasswordResetRateLimitError();
    } catch (error) {
      if (error instanceof PasswordResetRateLimitError) throw error;
      this.logger.warn('password_reset_request_unavailable');
      throw new PasswordResetRequestUnavailableError();
    }

    try {
      await this.outbox.assertReady();
      this.createResetUrl('A'.repeat(43));
    } catch {
      this.logger.warn('password_reset_request_unavailable');
      throw new PasswordResetRequestUnavailableError();
    }

    let account: Awaited<
      ReturnType<AuthenticationRepositoryPort['findAccountByEmail']>
    >;
    try {
      account = await this.repository.findAccountByEmail(email);
    } catch {
      this.logger.warn('password_reset_request_unavailable');
      throw new PasswordResetRequestUnavailableError();
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = digest(token);
    const eligibleAccount = account?.status === 'ACTIVE' ? account : null;
    const userScopeHash = eligibleAccount
      ? digest(eligibleAccount.userId)
      : digest(randomBytes(32).toString('base64url'));
    try {
      const saved = await this.outbox.savePasswordResetRequest({
        userScopeHash,
        tokenHash,
        userId: eligibleAccount?.userId ?? '000000000000000000000000',
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000),
        ...(eligibleAccount
          ? {
              payload: {
                recipientEmail: eligibleAccount.email,
                resetUrl: this.createResetUrl(token),
              },
            }
          : {}),
      });
      if (saved === 'NOT_SAVED')
        throw new Error('PASSWORD_RESET_OUTBOX_WRITE_NOT_APPLIED');
    } catch {
      this.logger.warn('password_reset_request_unavailable');
      throw new PasswordResetRequestUnavailableError();
    }

    return { status: 'accepted' };
  }

  async completeReset(input: CompletePasswordResetInput): Promise<void> {
    if (
      Array.from(input.password).length < MIN_PASSWORD_CHARACTERS ||
      Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_UTF8_BYTES
    )
      throw new PasswordResetPasswordPolicyError();

    const sourceDigest = digest(input.sourceIp || 'unknown');
    if (
      !(await this.security.consumeRateLimit(
        `auth:password-reset:complete:${sourceDigest}`,
        RESET_SOURCE_LIMIT,
        RESET_RATE_WINDOW_SECONDS,
      ))
    ) {
      throw new PasswordResetRateLimitError();
    }

    if (!RESET_TOKEN_PATTERN.test(input.token))
      throw new PasswordResetInvalidTokenError();

    const tokenHash = digest(input.token);
    const claimId = randomBytes(32).toString('base64url');
    const claim = await this.outbox.claimPasswordResetToken(tokenHash, claimId);
    if (!claim) throw new PasswordResetInvalidTokenError();

    let updated: boolean;
    try {
      const passwordHash = await this.credentials.hashPassword(input.password);
      updated = await this.repository.resetPassword(claim.userId, passwordHash);
    } catch (error) {
      try {
        await this.outbox.releasePasswordResetTokenClaim(
          claim.userScopeHash,
          claimId,
        );
      } catch {
        this.logger.warn('password_reset_token_claim_release_failed');
      }
      throw error;
    }

    // The Mongo transaction has committed (or confirmed the account inactive)
    // before the one-time token document is removed. A Mongo error here leaves
    // the claim in place until expiry, preventing replay.
    const consumed = await this.outbox.consumeClaimedPasswordResetToken(
      tokenHash,
      claim.userScopeHash,
      claimId,
    );
    if (!consumed)
      this.logger.warn('password_reset_token_consume_after_commit_failed');
    if (!updated) throw new PasswordResetInvalidTokenError();
  }

  private createResetUrl(token: string): string {
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

    const resetUrl = new URL('/reset-password', baseUrl);
    resetUrl.hash = new URLSearchParams({ token }).toString();
    return resetUrl.toString();
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
