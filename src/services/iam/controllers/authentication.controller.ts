import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request, Response } from 'express';
import { verifyGatewaySource } from '../../../common/http/gateway-source';
import {
  AuthenticationApplicationService,
  type AuthenticatedIdentity,
  type AuthenticatedPlatformSubject,
  type PlatformLoginResult,
  type LoginResult,
  readCookie,
  RefreshCsrfError,
} from '../application/authentication/authentication.application.service';
import {
  LoginCredentialsDto,
  LoginRequestDto,
  PlatformLoginRequestDto,
} from '../application/authentication/login-request.dto';

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

async function parseLoginBody<T extends LoginCredentialsDto>(
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
): void {
  response.setHeader('Set-Cookie', [
    serializeAccessCookie(result.accessToken),
    serializeRefreshCookie(result.refreshToken),
    serializeCsrfCookie(result.csrfToken),
  ]);
}

function loginSourceIp(request: Request, config: ConfigService): string {
  if (!request.originalUrl.startsWith('/internal/'))
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  return (
    verifyGatewaySource(
      request.headers,
      config.get<string>('IAM_GATEWAY_SECRET') ?? '',
    ) ?? ''
  );
}

function ensureTrustedLoginSource(
  request: Request,
  config: ConfigService,
): string {
  const sourceIp = loginSourceIp(request, config);
  if (!sourceIp) {
    throw new UnauthorizedException({
      code: 'INVALID_GATEWAY_SOURCE',
      message: 'Gateway source proof is invalid.',
    });
  }
  return sourceIp;
}

@Controller('auth')
export class AuthenticationController {
  constructor(
    private readonly service: AuthenticationApplicationService,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: AuthenticatedIdentity }> {
    response.setHeader('Cache-Control', 'no-store');
    const dto = await parseLoginBody(body, LoginRequestDto);
    const sourceIp = ensureTrustedLoginSource(request, this.config);
    const result = await this.service.login({ ...dto, sourceIp });
    setLoginCookies(response, result);
    return { user: result.user };
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
    return this.service.getCurrentIdentity(authorization, cookie);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'logged_out' }> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      await this.service.logout(authorization, cookie);
      return { status: 'logged_out' };
    } finally {
      response.setHeader('Set-Cookie', [
        clearAccessCookie(),
        clearRefreshCookie(),
      ]);
    }
  }
}
