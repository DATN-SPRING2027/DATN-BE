import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Req,
  Res,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request, Response } from 'express';
import { hasCookieName } from '../../../common/http/cookies';
import {
  classifyGoogleOAuthError,
  createGoogleOAuthRequestId,
  logGoogleOAuthStage,
} from '../application/authentication/google-oauth.observability';
import {
  AuthenticationApplicationService,
  type AuthenticatedPlatformSubject,
  type PlatformLoginResult,
  type LoginResult,
  readCookie,
  RefreshCsrfError,
  validCsrfPair,
} from '../application/authentication/authentication.application.service';
import {
  LoginRequestDto,
  PlatformLoginRequestDto,
} from '../application/authentication/login-request.dto';
import { GoogleOAuthService } from '../application/authentication/google-oauth.service';
import {
  PasswordResetInvalidTokenError,
  PasswordResetPasswordPolicyError,
  PasswordResetRateLimitError,
  PasswordResetRequestUnavailableError,
  PasswordResetService,
} from '../application/authentication/password-reset.service';
import {
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
} from '../application/authentication/password-reset.request.dto';
import { ensureTrustedLoginSource } from './auth-source-ip';

export const GOOGLE_OAUTH_STATE_COOKIE = '__Host-continuum-google-oauth-state';

function serializeAccessCookie(token: string): string {
  const parts = [
    `continuum_access=${encodeURIComponent(token)}`,
    'Path=/',
    'Max-Age=900',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.NODE_ENV !== 'test'
  ) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function serializeRefreshCookie(token: string): string {
  return [
    `__Secure-refresh=${encodeURIComponent(token)}`,
    'Path=/api/v1/auth',
    'Max-Age=604800',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

function serializeCsrfCookie(token: string): string {
  return [
    `__Host-csrf=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

function clearAccessCookie(): string {
  const parts = [
    'continuum_access=',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.NODE_ENV !== 'test'
  ) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function clearRefreshCookie(): string {
  return [
    '__Secure-refresh=',
    'Path=/api/v1/auth',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

function clearCsrfCookie(): string {
  return [
    '__Host-csrf=',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

async function parseLoginBody<T extends object>(
  body: unknown,
  dtoType: new () => T,
): Promise<T> {
  const dto = plainToInstance(dtoType, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    validationError: { target: false, value: false },
  });
  if (errors.length > 0) {
    throw new UnprocessableEntityException({
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed.',
    });
  }
  return dto;
}

function setLoginCookies(
  response: Response,
  result: LoginResult | PlatformLoginResult,
  additionalCookies: string[] = [],
): void {
  response.setHeader('Set-Cookie', [
    serializeAccessCookie(result.accessToken),
    serializeRefreshCookie(result.refreshToken),
    serializeCsrfCookie(result.csrfToken),
    ...additionalCookies,
  ]);
}

function serializeGoogleOAuthStateCookie(value: string): string {
  const parts = [
    `${GOOGLE_OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'Max-Age=600',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ];
  return parts.join('; ');
}

function clearGoogleOAuthStateCookie(): string {
  const parts = [
    `${GOOGLE_OAUTH_STATE_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ];
  return parts.join('; ');
}

@Controller('auth')
export class AuthenticationController {
  constructor(
    private readonly service: AuthenticationApplicationService,
    private readonly config: ConfigService,
    private readonly googleOAuth: GoogleOAuthService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Get('google')
  async beginGoogleLogin(
    @Query('organizationId') organizationId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const result = await this.googleOAuth.begin(organizationId);
    response.setHeader(
      'Set-Cookie',
      serializeGoogleOAuthStateCookie(result.stateCookie),
    );
    response.redirect(302, result.authorizationUrl);
  }

  @Get('google/callback')
  async finishGoogleLogin(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') providerError: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const requestId = createGoogleOAuthRequestId(
      request.headers['x-request-id'],
    );
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const clearStateCookie = clearGoogleOAuthStateCookie();
    logGoogleOAuthStage({
      requestId,
      stage: 'callback_received',
      status: 'started',
    });

    if (providerError) {
      logGoogleOAuthStage({
        requestId,
        stage: 'provider_authorization',
        status: 'failed',
        errorCode: 'GOOGLE_USER_CANCELLED',
      });
      response.setHeader('Set-Cookie', clearStateCookie);
      response.redirect(302, '/signin?google=cancelled');
      return;
    }

    try {
      const identity = await this.googleOAuth.verifyCallback(
        {
          code: code ?? '',
          state: state ?? '',
          stateCookie:
            readCookie(request.headers.cookie, GOOGLE_OAUTH_STATE_COOKIE) ?? '',
        },
        requestId,
      );
      logGoogleOAuthStage({
        requestId,
        stage: 'google_identity_verified',
        status: 'succeeded',
      });

      const result = await this.service.loginWithGoogle(
        identity,
        identity.organizationId,
        requestId,
      );
      setLoginCookies(response, result, [clearStateCookie]);
      logGoogleOAuthStage({
        requestId,
        stage: 'session_cookie_response',
        status: 'succeeded',
      });
      response.redirect(302, '/select-organization');
      logGoogleOAuthStage({
        requestId,
        stage: 'callback_completed',
        status: 'succeeded',
      });
    } catch (error) {
      const errorCode =
        error instanceof ConflictException
          ? 'ORGANIZATION_SELECTION_REQUIRED'
          : error instanceof ForbiddenException
            ? 'ORGANIZATION_ACCESS_REQUIRED'
            : classifyGoogleOAuthError(error, 'GOOGLE_CALLBACK_FAILED');
      logGoogleOAuthStage({
        requestId,
        stage: 'callback_completed',
        status: 'failed',
        errorCode,
      });
      response.setHeader('Set-Cookie', clearStateCookie);
      if (
        error instanceof ConflictException ||
        error instanceof ForbiddenException
      ) {
        response.status(error.getStatus()).json(error.getResponse());
        return;
      }
      response.redirect(302, '/signin?google=failed');
    }
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: LoginResult['user'] }> {
    response.setHeader('Cache-Control', 'no-store');
    const dto = await parseLoginBody(body, LoginRequestDto);
    const sourceIp = ensureTrustedLoginSource(request, this.config);
    const result = await this.service.login({ ...dto, sourceIp });
    setLoginCookies(response, result);
    return { user: result.user };
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestPasswordReset(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'accepted' }> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const dto = await parseLoginBody(body, PasswordResetRequestDto);
    const sourceIp = ensureTrustedLoginSource(request, this.config);
    try {
      return await this.passwordReset.requestReset({
        email: dto.email,
        sourceIp,
      });
    } catch (error) {
      if (error instanceof PasswordResetRateLimitError) {
        throw new HttpException(
          {
            code: 'PASSWORD_RESET_RATE_LIMITED',
            message: 'Too many password reset requests.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof PasswordResetRequestUnavailableError) {
        throw new ServiceUnavailableException({
          code: 'PASSWORD_RESET_REQUEST_UNAVAILABLE',
          message: 'Password reset is temporarily unavailable.',
        });
      }
      throw error;
    }
  }

  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmPasswordReset(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const dto = await parseLoginBody(body, PasswordResetConfirmDto);
    const sourceIp = ensureTrustedLoginSource(request, this.config);
    try {
      await this.passwordReset.completeReset({ ...dto, sourceIp });
      response.setHeader('Set-Cookie', [
        clearAccessCookie(),
        clearRefreshCookie(),
        clearCsrfCookie(),
      ]);
    } catch (error) {
      if (error instanceof PasswordResetRateLimitError) {
        throw new HttpException(
          {
            code: 'PASSWORD_RESET_RATE_LIMITED',
            message: 'Too many password reset attempts.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof PasswordResetInvalidTokenError) {
        throw new BadRequestException({
          code: 'PASSWORD_RESET_TOKEN_INVALID',
          message: 'Password reset link is invalid or has expired.',
        });
      }
      if (error instanceof PasswordResetPasswordPolicyError) {
        throw new UnprocessableEntityException({
          code: 'PASSWORD_RESET_PASSWORD_INVALID',
          message: 'Password must fit the supported length limit.',
        });
      }
      throw error;
    }
  }

  @Post('platform/login')
  @HttpCode(HttpStatus.OK)
  async loginPlatform(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ context: 'PLATFORM'; user: AuthenticatedPlatformSubject }> {
    response.setHeader('Cache-Control', 'no-store');
    const dto = await parseLoginBody(body, PlatformLoginRequestDto);
    const sourceIp = ensureTrustedLoginSource(request, this.config);
    const result = await this.service.loginPlatform({ ...dto, sourceIp });
    setLoginCookies(response, result);
    return { context: 'PLATFORM', user: result.user };
  }

  @Post('select-organization')
  @HttpCode(HttpStatus.OK)
  async selectOrganization(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: LoginResult['user'] }> {
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('organizationId' in body) ||
      typeof body.organizationId !== 'string' ||
      !/^[a-fA-F0-9]{24}$/.test(body.organizationId)
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    const result = await this.service.selectOrganization(
      authorization,
      cookie,
      body.organizationId,
    );
    setLoginCookies(response, result);
    return { user: result.user };
  }

  @Get('organizations')
  async listOrganizationOptions(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.listOrganizationOptions(authorization, cookie);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'refreshed' }> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const result = await this.service.refresh(
        readCookie(cookie, '__Secure-refresh'),
        readCookie(cookie, '__Host-csrf'),
        csrfHeader,
      );
      response.setHeader('Set-Cookie', [
        serializeAccessCookie(result.accessToken),
        serializeRefreshCookie(result.refreshToken),
      ]);
      return { status: 'refreshed' };
    } catch (error) {
      if (error instanceof RefreshCsrfError) {
        throw new ForbiddenException({
          code: 'AUTH_CSRF_INVALID',
          message: 'CSRF validation failed.',
        });
      }
      if (error instanceof UnauthorizedException) {
        throw new UnauthorizedException({
          code: 'AUTH_REFRESH_INVALID',
          message: 'Refresh credential is invalid.',
        });
      }
      throw new InternalServerErrorException({
        code: 'AUTH_REFRESH_FAILED',
        message: 'Refresh failed.',
      });
    }
  }

  @Get('me')
  async getCurrentIdentity(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.getCurrentSessionIdentity(authorization, cookie);
  }

  @Get('platform/me')
  async getCurrentPlatformSessionIdentity(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.getCurrentPlatformSessionIdentity(
      authorization,
      cookie,
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'logged_out' }> {
    response.setHeader('Cache-Control', 'no-store');
    const hasSessionCookie = [
      'continuum_access',
      '__Secure-refresh',
      'continuum_refresh',
    ].some((name) => hasCookieName(cookie, name));
    if (
      hasSessionCookie &&
      !validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader)
    )
      throw new ForbiddenException({
        code: 'AUTH_CSRF_INVALID',
        message: 'CSRF validation failed.',
      });
    try {
      await this.service.logout(authorization, cookie);
      return { status: 'logged_out' };
    } finally {
      response.setHeader('Set-Cookie', [
        clearAccessCookie(),
        clearRefreshCookie(),
        clearCsrfCookie(),
      ]);
    }
  }
}
