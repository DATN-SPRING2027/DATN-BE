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
  PASSWORD_RESET_MAILER,
  type PasswordResetMailer,
} from './password-reset.mailer';
import {
  PASSWORD_RESET_TOKEN_STORE,
  type PasswordResetTokenStore,
} from './password-reset.store';
import { PasswordCredentialService } from '../credentials/password-credential.service';

const RESET_TOKEN_TTL_SECONDS = 30 * 60;
const RESET_SOURCE_LIMIT = 20;
const RESET_EMAIL_LIMIT = 3;
const RESET_RATE_WINDOW_SECONDS = 15 * 60;
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BCRYPT_MAX_PASSWORD_BYTES = 72;

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
    @Inject(PASSWORD_RESET_TOKEN_STORE)
    private readonly tokens: PasswordResetTokenStore,
    private readonly credentials: PasswordCredentialService,
    @Inject(PASSWORD_RESET_MAILER)
    private readonly mailer: PasswordResetMailer,
    private readonly config: ConfigService,
  ) {}

  async requestReset(
    input: RequestPasswordResetInput,
  ): Promise<{ status: 'accepted' }> {
    const email = input.email.trim().toLowerCase();
    const emailDigest = digest(email);
    const sourceDigest = digest(input.sourceIp || 'unknown');

    if (
      !(await this.security.consumeRateLimit(
        `auth:password-reset:source:${sourceDigest}`,
        RESET_SOURCE_LIMIT,
        RESET_RATE_WINDOW_SECONDS,
      )) ||
      !(await this.security.consumeRateLimit(
        `auth:password-reset:email:${emailDigest}`,
        RESET_EMAIL_LIMIT,
        RESET_RATE_WINDOW_SECONDS,
      ))
    ) {
      throw new PasswordResetRateLimitError();
    }

    const account = await this.repository.findAccountByEmail(email);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = digest(token);
    const eligible = account?.status === 'ACTIVE';
    const userScopeHash = eligible
      ? digest(account.userId)
      : digest(`no-active-account:${emailDigest}`);
    const userId = eligible ? account.userId : '000000000000000000000000';
    await this.tokens.savePasswordResetToken(
      userScopeHash,
      tokenHash,
      userId,
      RESET_TOKEN_TTL_SECONDS,
    );

    if (!eligible || !account) {
      await this.tokens.discardPasswordResetToken(userScopeHash, tokenHash);
    } else {
      await this.tokens.discardPasswordResetToken(
        digest(`no-active-account:${emailDigest}`),
        digest(randomBytes(32).toString('base64url')),
      );
      // SMTP latency and errors must not reveal whether the account exists.
      setImmediate(() => {
        void this.deliverResetEmail(
          account.email,
          token,
          userScopeHash,
          tokenHash,
        );
      });
    }

    return { status: 'accepted' };
  }

  async completeReset(input: CompletePasswordResetInput): Promise<void> {
    if (Buffer.byteLength(input.password, 'utf8') > BCRYPT_MAX_PASSWORD_BYTES)
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

    const userId = await this.tokens.consumePasswordResetToken(
      digest(input.token),
    );
    if (!userId) throw new PasswordResetInvalidTokenError();

    const passwordHash = await this.credentials.hashPassword(input.password);
    const updated = await this.repository.resetPassword(userId, passwordHash);
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
    resetUrl.searchParams.set('token', token);
    return resetUrl.toString();
  }

  private async deliverResetEmail(
    email: string,
    token: string,
    userScopeHash: string,
    tokenHash: string,
  ): Promise<void> {
    try {
      await this.mailer.sendPasswordResetEmail(
        email,
        this.createResetUrl(token),
      );
    } catch {
      try {
        await this.tokens.discardPasswordResetToken(userScopeHash, tokenHash);
      } catch {
        this.logger.warn('password_reset_token_cleanup_failed');
      }
      this.logger.warn('password_reset_email_delivery_failed');
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
