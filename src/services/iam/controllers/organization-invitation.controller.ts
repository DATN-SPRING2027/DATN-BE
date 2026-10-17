import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
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

function parseAcceptBody(body: unknown): void {
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
    Number(record.expectedMembershipVersion) < 1 ||
    !Number.isSafeInteger(record.expectedInvitationVersion) ||
    Number(record.expectedInvitationVersion) < 1
  )
    return validationFailed();
}

@Controller('auth/invitations')
export class AccountInvitationController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly invitations: OrganizationInvitationService,
  ) {}

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
  async accept(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('invitationId') invitationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<never> {
    response.setHeader('Cache-Control', 'no-store');
    await this.auth.getCurrentSessionIdentity(authorization, cookie);
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    if (
      !objectIdPattern.test(invitationId) ||
      !idempotencyKey ||
      !idempotencyPattern.test(idempotencyKey)
    )
      return validationFailed();
    parseAcceptBody(body);
    throw new ServiceUnavailableException({
      code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
    });
  }
}
