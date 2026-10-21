import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import {
  readCookie,
  validCsrfPair,
} from '../application/authentication/authentication.application.service';
import { OrganizationInvitationService } from '../application/organizations/organization-invitation.service';

const objectIdPattern = /^[a-f\d]{24}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;

function validationFailed(): never {
  throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
}

function parsePageQuery(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
} {
  if (
    Object.keys(query).some((key) => !['page', 'pageSize'].includes(key)) ||
    (query.page !== undefined &&
      (typeof query.page !== 'string' || !/^\d+$/.test(query.page))) ||
    (query.pageSize !== undefined &&
      (typeof query.pageSize !== 'string' || !/^\d+$/.test(query.pageSize)))
  )
    return validationFailed();
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    return validationFailed();
  return { page, pageSize };
}

function parseAcceptBody(body: unknown): {
  expectedMembershipVersion: number;
  expectedInvitationVersion: number;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return validationFailed();
  const record = body as Record<string, unknown>;
  const expectedKeys = [
    'expectedMembershipVersion',
    'expectedInvitationVersion',
  ];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(record, key)) ||
    !Number.isSafeInteger(record.expectedMembershipVersion) ||
    Number(record.expectedMembershipVersion) < 0 ||
    !Number.isSafeInteger(record.expectedInvitationVersion) ||
    Number(record.expectedInvitationVersion) < 1
  )
    return validationFailed();
  return {
    expectedMembershipVersion: Number(record.expectedMembershipVersion),
    expectedInvitationVersion: Number(record.expectedInvitationVersion),
  };
}

function parseResolveBody(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return validationFailed();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, 'token') ||
    typeof record.token !== 'string'
  )
    return validationFailed();
  return record.token;
}

@Controller('auth/invitations')
export class AccountInvitationController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly invitations: OrganizationInvitationService,
  ) {}

  @Post('resolve')
  @HttpCode(200)
  async resolve(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.invitations.resolveToken(parseResolveBody(body));
  }

  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentSessionIdentity(
      authorization,
      cookie,
    );
    const { page, pageSize } = parsePageQuery(query);
    return this.invitations.listMine(actor, page, pageSize);
  }

  @Get(':invitationId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('invitationId') invitationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentSessionIdentity(
      authorization,
      cookie,
    );
    return this.invitations.getMine(actor, invitationId);
  }

  @Post(':invitationId/accept')
  @HttpCode(200)
  async accept(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('invitationId') invitationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentSessionIdentity(
      authorization,
      cookie,
    );
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      !objectIdPattern.test(invitationId) ||
      !idempotencyKey ||
      !idempotencyPattern.test(idempotencyKey)
    )
      return validationFailed();
    const input = parseAcceptBody(body);
    const result = await this.invitations.accept(
      actor,
      invitationId,
      input.expectedMembershipVersion,
      input.expectedInvitationVersion,
      idempotencyKey,
    );
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return result.acknowledgement;
  }
}
