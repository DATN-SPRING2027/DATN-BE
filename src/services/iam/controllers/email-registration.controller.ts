import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request, Response } from 'express';
import { ensureTrustedLoginSource } from './auth-source-ip';
import {
  EmailRegistrationRequestDto,
  EmailRegistrationVerifyDto,
} from '../application/authentication/email-registration.request.dto';
import {
  EmailRegistrationInvalidTokenError,
  EmailRegistrationPasswordPolicyError,
  EmailRegistrationRateLimitError,
  EmailRegistrationRequestUnavailableError,
  EmailRegistrationService,
  EmailRegistrationVerificationUnavailableError,
} from '../application/authentication/email-registration.service';

async function parseRegistrationBody<T extends object>(
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

@Controller('auth/registrations')
export class EmailRegistrationController {
  constructor(
    private readonly registrations: EmailRegistrationService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async requestRegistration(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'accepted' }> {
    this.setPrivateHeaders(response);
    const dto = await parseRegistrationBody(body, EmailRegistrationRequestDto);
    const sourceIp = ensureTrustedLoginSource(request, this.config);
    try {
      return await this.registrations.requestRegistration({
        fullName: dto.fullName,
        email: dto.email,
        sourceIp,
      });
    } catch (error) {
      if (error instanceof EmailRegistrationRateLimitError) {
        response.setHeader('Retry-After', '900');
        throw new HttpException(
          {
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many registration requests.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof EmailRegistrationRequestUnavailableError) {
        throw new ServiceUnavailableException({
          code: 'EMAIL_REGISTRATION_UNAVAILABLE',
          message: 'Registration is temporarily unavailable.',
        });
      }
      throw error;
    }
  }

  @Post('verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyRegistration(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    this.setPrivateHeaders(response);
    const dto = await parseRegistrationBody(body, EmailRegistrationVerifyDto);
    const sourceIp = ensureTrustedLoginSource(request, this.config);
    try {
      await this.registrations.completeRegistration({ ...dto, sourceIp });
    } catch (error) {
      if (error instanceof EmailRegistrationRateLimitError) {
        response.setHeader('Retry-After', '900');
        throw new HttpException(
          {
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many registration verification attempts.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof EmailRegistrationInvalidTokenError) {
        throw new BadRequestException({
          code: 'EMAIL_REGISTRATION_TOKEN_INVALID',
          message: 'Registration link is invalid or has expired.',
        });
      }
      if (error instanceof EmailRegistrationPasswordPolicyError) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed.',
        });
      }
      if (error instanceof EmailRegistrationVerificationUnavailableError) {
        throw new ServiceUnavailableException({
          code: 'EMAIL_REGISTRATION_VERIFICATION_UNAVAILABLE',
          message: 'Registration verification is temporarily unavailable.',
        });
      }
      throw error;
    }
  }

  private setPrivateHeaders(response: Response): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
