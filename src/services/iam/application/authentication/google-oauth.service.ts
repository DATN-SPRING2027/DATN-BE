import {
  UnprocessableEntityException,
  ServiceUnavailableException,
  UnauthorizedException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CodeChallengeMethod,
  OAuth2Client,
  type TokenPayload,
} from 'google-auth-library';
import {
  classifyGoogleOAuthError,
  createGoogleOAuthRequestId,
  logGoogleOAuthStage,
} from './google-oauth.observability';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const GOOGLE_SCOPES = ['openid', 'email', 'profile'];
const TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;
const COOKIE_AAD = Buffer.from('continuum-google-oauth-transaction-v1');

interface GoogleOAuthTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  issuedAt: number;
  organizationId?: string;
}

export interface GoogleOAuthStartResult {
  authorizationUrl: string;
  stateCookie: string;
}

export interface GoogleCallbackInput {
  code: string;
  state: string;
  stateCookie: string;
}

export interface VerifiedGoogleIdentity {
  subject: string;
  email: string;
  emailVerified: true;
  name?: string;
  organizationId?: string;
}

@Injectable()
export class GoogleOAuthService {
  constructor(private readonly config: ConfigService) {}

  async begin(organizationId?: string): Promise<GoogleOAuthStartResult> {
    if (organizationId && !/^[a-f\d]{24}$/i.test(organizationId)) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_FAILED',
        message: 'Organization selection is invalid.',
      });
    }
    const configuration = this.getConfiguration();
    const client = this.createClient(configuration);
    const { codeVerifier, codeChallenge } =
      await client.generateCodeVerifierAsync();
    if (!codeVerifier || !codeChallenge)
      throw new ServiceUnavailableException('Google OAuth is unavailable.');

    const transaction: GoogleOAuthTransaction = {
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      codeVerifier,
      issuedAt: Date.now(),
      ...(organizationId ? { organizationId } : {}),
    };
    const authorizationUrl = client.generateAuthUrl({
      scope: GOOGLE_SCOPES,
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return {
      authorizationUrl,
      stateCookie: this.encryptTransaction(
        transaction,
        configuration.jwtSecret,
      ),
    };
  }

  async verifyCallback(
    input: GoogleCallbackInput,
    requestId?: string,
  ): Promise<VerifiedGoogleIdentity> {
    const correlationId = createGoogleOAuthRequestId(requestId);
    logGoogleOAuthStage({
      requestId: correlationId,
      stage: 'oauth_configuration',
      status: 'started',
    });

    let configuration: ReturnType<GoogleOAuthService['getConfiguration']>;
    try {
      configuration = this.getConfiguration();
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'oauth_configuration',
        status: 'succeeded',
      });
    } catch (error) {
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'oauth_configuration',
        status: 'failed',
        errorCode: classifyGoogleOAuthError(
          error,
          'GOOGLE_OAUTH_CONFIGURATION_UNAVAILABLE',
        ),
      });
      throw error;
    }

    logGoogleOAuthStage({
      requestId: correlationId,
      stage: 'state_validation',
      status: 'started',
    });
    let transaction: GoogleOAuthTransaction;
    try {
      if (
        !input.code ||
        input.code.length > 4096 ||
        !input.state ||
        input.state.length > 512 ||
        !input.stateCookie
      ) {
        throw new UnauthorizedException('Google authentication failed.');
      }

      transaction = this.decryptTransaction(
        input.stateCookie,
        configuration.jwtSecret,
      );
      if (
        transaction.state !== input.state ||
        Date.now() - transaction.issuedAt > TRANSACTION_LIFETIME_MS ||
        transaction.issuedAt > Date.now() + 30_000
      ) {
        throw new UnauthorizedException('Google authentication failed.');
      }
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'state_validation',
        status: 'succeeded',
      });
    } catch (error) {
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'state_validation',
        status: 'failed',
        errorCode: 'OAUTH_STATE_INVALID',
      });
      throw error;
    }

    const client = this.createClient(configuration);
    logGoogleOAuthStage({
      requestId: correlationId,
      stage: 'token_exchange',
      status: 'started',
    });
    let idToken: string | undefined;
    try {
      const tokenResponse = await client.getToken({
        code: input.code,
        codeVerifier: transaction.codeVerifier,
      });
      idToken = tokenResponse.tokens.id_token ?? undefined;
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'token_exchange',
        status: 'succeeded',
      });
    } catch (error) {
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'token_exchange',
        status: 'failed',
        errorCode: classifyGoogleOAuthError(
          error,
          'GOOGLE_TOKEN_EXCHANGE_FAILED',
        ),
      });
      throw error;
    }

    if (!idToken) {
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'id_token_verification',
        status: 'failed',
        errorCode: 'GOOGLE_ID_TOKEN_MISSING',
      });
      throw new UnauthorizedException('Google authentication failed.');
    }

    logGoogleOAuthStage({
      requestId: correlationId,
      stage: 'id_token_verification',
      status: 'started',
    });
    let payload: TokenPayload | undefined;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: configuration.clientId,
      });
      payload = ticket.getPayload();
      if (
        !payload ||
        !payload.sub ||
        !payload.email ||
        payload.nonce !== transaction.nonce ||
        !['https://accounts.google.com', 'accounts.google.com'].includes(
          payload.iss,
        )
      ) {
        throw new UnauthorizedException('Google authentication failed.');
      }
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'id_token_verification',
        status: 'succeeded',
      });
    } catch (error) {
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'id_token_verification',
        status: 'failed',
        errorCode: classifyGoogleOAuthError(error, 'GOOGLE_ID_TOKEN_INVALID'),
      });
      throw error;
    }

    logGoogleOAuthStage({
      requestId: correlationId,
      stage: 'email_verification',
      status: 'started',
    });
    if (payload.email_verified !== true) {
      logGoogleOAuthStage({
        requestId: correlationId,
        stage: 'email_verification',
        status: 'failed',
        errorCode: 'GOOGLE_EMAIL_UNVERIFIED',
      });
      throw new UnauthorizedException('Google authentication failed.');
    }
    logGoogleOAuthStage({
      requestId: correlationId,
      stage: 'email_verification',
      status: 'succeeded',
    });

    return {
      subject: payload.sub,
      email: payload.email.trim().toLowerCase(),
      emailVerified: true,
      ...(payload.name ? { name: payload.name } : {}),
      ...(transaction.organizationId
        ? { organizationId: transaction.organizationId }
        : {}),
    };
  }

  private getConfiguration(): {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    jwtSecret: string;
  } {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim();
    const clientSecret = this.config
      .get<string>('GOOGLE_CLIENT_SECRET')
      ?.trim();
    const callbackUrl = this.config.get<string>('GOOGLE_CALLBACK_URL')?.trim();
    const jwtSecret = this.config.get<string>('JWT_SECRET');
    if (
      !clientId ||
      !clientSecret ||
      !callbackUrl ||
      !jwtSecret ||
      jwtSecret.length < 32
    ) {
      throw new ServiceUnavailableException('Google OAuth is unavailable.');
    }
    return { clientId, clientSecret, callbackUrl, jwtSecret };
  }

  private createClient(configuration: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
  }): OAuth2Client {
    return new OAuth2Client(
      configuration.clientId,
      configuration.clientSecret,
      configuration.callbackUrl,
    );
  }

  private encryptTransaction(
    transaction: GoogleOAuthTransaction,
    secret: string,
  ): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.deriveKey(secret), iv);
    cipher.setAAD(COOKIE_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(transaction), 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  private decryptTransaction(
    cookie: string,
    secret: string,
  ): GoogleOAuthTransaction {
    try {
      const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
        cookie.split('.');
      if (
        version !== 'v1' ||
        !encodedIv ||
        !encodedTag ||
        !encodedCiphertext ||
        extra !== undefined
      ) {
        throw new Error('Malformed transaction cookie');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.deriveKey(secret),
        Buffer.from(encodedIv, 'base64url'),
      );
      decipher.setAAD(COOKIE_AAD);
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      const value = JSON.parse(plaintext) as Partial<GoogleOAuthTransaction>;
      if (
        typeof value.state !== 'string' ||
        typeof value.nonce !== 'string' ||
        typeof value.codeVerifier !== 'string' ||
        typeof value.issuedAt !== 'number' ||
        (value.organizationId !== undefined &&
          typeof value.organizationId !== 'string')
      ) {
        throw new Error('Invalid transaction payload');
      }
      return value as GoogleOAuthTransaction;
    } catch {
      throw new UnauthorizedException('Google authentication failed.');
    }
  }

  private deriveKey(secret: string): Buffer {
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(secret, 'utf8'),
        Buffer.from('continuum-ai'),
        Buffer.from('google-oauth-transaction-v1'),
        32,
      ),
    );
  }
}
