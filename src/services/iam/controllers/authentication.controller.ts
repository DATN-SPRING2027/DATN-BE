import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request, Response } from 'express';
import { isIP } from 'node:net';
import {
  AuthenticationApplicationService,
  type AuthenticatedIdentity,
} from '../application/authentication/authentication.application.service';
import { LoginRequestDto } from '../application/authentication/login-request.dto';

function serializeAccessCookie(token: string): string {
  const parts = [
    `continuum_access=${encodeURIComponent(token)}`,
    'Path=/',
    'Max-Age=900',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.NODE_ENV !== 'test'
  ) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function clearAccessCookie(): string {
  const parts = [
    'continuum_access=',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.NODE_ENV !== 'test'
  ) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

async function parseLoginBody(body: unknown): Promise<LoginRequestDto> {
  const dto = plainToInstance(LoginRequestDto, body);
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

@Controller('auth')
export class AuthenticationController {
  constructor(private readonly service: AuthenticationApplicationService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: AuthenticatedIdentity }> {
    response.setHeader('Cache-Control', 'no-store');
    const dto = await parseLoginBody(body);
    const forwardedSource = request.headers['x-iam-source-ip'];
    const loopbackPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      request.socket.remoteAddress ?? '',
    );
    const sourceIp =
      loopbackPeer &&
      typeof forwardedSource === 'string' &&
      isIP(forwardedSource)
        ? forwardedSource
        : (request.ip ?? request.socket.remoteAddress ?? 'unknown');
    const result = await this.service.login({ ...dto, sourceIp });
    response.setHeader('Set-Cookie', serializeAccessCookie(result.accessToken));
    return { user: result.user };
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
      response.setHeader('Set-Cookie', clearAccessCookie());
    }
  }
}
