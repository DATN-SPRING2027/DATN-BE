import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import {
  readCookie,
  validCsrfPair,
} from '../application/authentication/authentication.application.service';
import { OrganizationMembershipCommandService } from '../application/organizations/organization-membership-command.service';
import type { OrganizationMembershipCommand } from '../application/organizations/organization-membership-command.repository';

const objectIdPattern = /^[a-f\d]{24}$/i;
const reasonCodes = new Set([
  'ACCESS_REQUEST',
  'ACCESS_REVIEW',
  'INVITATION_CANCELLED',
  'SECURITY_INCIDENT',
]);

function validationFailed(): never {
  throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return validationFailed();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    return validationFailed();
  return Number(value);
}

function parseReason(value: unknown): string {
  if (typeof value !== 'string' || !reasonCodes.has(value))
    return validationFailed();
  return value;
}

function parseInvite(body: unknown): OrganizationMembershipCommand {
  const record = parseObject(body);
  if (
    !exactKeys(record, ['email', 'reasonCode']) ||
    typeof record.email !== 'string' ||
    !['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(
      parseReason(record.reasonCode),
    )
  )
    return validationFailed();
  return {
    command: 'INVITE',
    email: record.email,
    reasonCode: record.reasonCode as 'ACCESS_REQUEST' | 'ACCESS_REVIEW',
  };
}

function parseInvitationAction(
  body: unknown,
  invitationId: string,
  command: 'RESEND' | 'CANCEL',
): OrganizationMembershipCommand {
  if (!objectIdPattern.test(invitationId)) return validationFailed();
  const record = parseObject(body);
  const expectedKeys = ['expectedInvitationVersion', 'reasonCode'];
  if (!exactKeys(record, expectedKeys)) return validationFailed();
  const invitationVersion = parseVersion(record.expectedInvitationVersion);
  const reasonCode = parseReason(record.reasonCode);
  if (command === 'RESEND') {
    if (!['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(reasonCode))
      return validationFailed();
    return {
      command,
      invitationId,
      expectedInvitationVersion: invitationVersion,
      reasonCode: reasonCode as 'ACCESS_REQUEST' | 'ACCESS_REVIEW',
    };
  }
  if (reasonCode !== 'INVITATION_CANCELLED') return validationFailed();
  return {
    command,
    invitationId,
    expectedInvitationVersion: invitationVersion,
    reasonCode,
  };
}

function parseSuspend(
  body: unknown,
  membershipId: string,
): OrganizationMembershipCommand {
  if (!objectIdPattern.test(membershipId)) return validationFailed();
  const record = parseObject(body);
  if (
    !exactKeys(record, ['expectedMembershipVersion', 'reasonCode']) ||
    !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(
      parseReason(record.reasonCode),
    )
  )
    return validationFailed();
  return {
    command: 'SUSPEND',
    membershipId,
    expectedMembershipVersion: parseVersion(record.expectedMembershipVersion),
    reasonCode: record.reasonCode as 'SECURITY_INCIDENT' | 'ACCESS_REVIEW',
  };
}

function parseSetOrganizationRole(
  body: unknown,
  membershipId: string,
): OrganizationMembershipCommand {
  if (!objectIdPattern.test(membershipId)) return validationFailed();
  const record = parseObject(body);
  if (
    !exactKeys(record, [
      'expectedMembershipVersion',
      'expectedRoleVersion',
      'roleCode',
      'reason',
    ])
  )
    return validationFailed();
  const membershipVersion = parseVersion(record.expectedMembershipVersion);
  if (
    !Number.isSafeInteger(record.expectedRoleVersion) ||
    Number(record.expectedRoleVersion) < 0
  )
    return validationFailed();
  if (record.roleCode !== 'ADMIN' && record.roleCode !== 'MEMBER')
    return validationFailed();
  if (
    typeof record.reason !== 'string' ||
    record.reason.length > 500 ||
    record.reason.trim().length < 1 ||
    record.reason.trim().length > 500
  )
    return validationFailed();
  return {
    command: 'SET_ORGANIZATION_ROLE',
    membershipId,
    expectedMembershipVersion: membershipVersion,
    expectedRoleVersion: Number(record.expectedRoleVersion),
    roleCode: record.roleCode,
    reason: record.reason.trim(),
  };
}

function parsePageQuery(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
} {
  if (
    Object.keys(query).some((key) => !['page', 'pageSize'].includes(key)) ||
    (query.page !== undefined && typeof query.page !== 'string') ||
    (query.pageSize !== undefined && typeof query.pageSize !== 'string')
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

@Controller('iam/organizations/:organizationId')
export class OrganizationMembershipCommandController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly commands: OrganizationMembershipCommandService,
  ) {}

  @Get('invitations')
  async listInvitations(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('organizationId') organizationId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    const { page, pageSize } = parsePageQuery(query);
    return this.commands.listInvitations(actor, organizationId, page, pageSize);
  }

  @Post('invitations')
  @HttpCode(201)
  async invite(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    this.requireCsrf(cookie, csrfHeader);
    return this.executeCommand(
      actor,
      organizationId,
      idempotencyKey ?? '',
      parseInvite(body),
      correlationId,
      response,
    );
  }

  @Post('invitations/:invitationId/resend')
  @HttpCode(200)
  async resend(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executeAction(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      organizationId,
      () => parseInvitationAction(body, invitationId, 'RESEND'),
      response,
    );
  }

  @Post('invitations/:invitationId/cancel')
  @HttpCode(200)
  async cancel(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executeAction(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      organizationId,
      () => parseInvitationAction(body, invitationId, 'CANCEL'),
      response,
    );
  }

  @Post('memberships/:membershipId/suspend')
  @HttpCode(200)
  async suspend(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executeAction(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      correlationId,
      organizationId,
      () => parseSuspend(body, membershipId),
      response,
    );
  }

  @Post('memberships/:membershipId/role')
  @HttpCode(200)
  async setOrganizationRole(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Req() request: Request & { requestId?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.executeAction(
      authorization,
      cookie,
      csrfHeader,
      idempotencyKey,
      request.requestId ?? correlationId,
      organizationId,
      () => parseSetOrganizationRole(body, membershipId),
      response,
    );
  }

  private async executeAction(
    authorization: string | undefined,
    cookie: string | undefined,
    csrfHeader: string | undefined,
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
    organizationId: string,
    parseCommand: () => OrganizationMembershipCommand,
    response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    this.requireCsrf(cookie, csrfHeader);
    return this.executeCommand(
      actor,
      organizationId,
      idempotencyKey ?? '',
      parseCommand(),
      correlationId,
      response,
    );
  }

  private async executeCommand(
    actor: Awaited<
      ReturnType<AuthenticationApplicationService['getCurrentIdentity']>
    >,
    organizationId: string,
    idempotencyKey: string,
    command: OrganizationMembershipCommand,
    correlationId: string | undefined,
    response: Response,
  ) {
    try {
      const result = await this.commands.execute(
        actor,
        organizationId,
        idempotencyKey,
        command,
        correlationId,
      );
      response.status(result.httpStatus);
      this.applyReplayHeader(response, result.replayed);
      return result.body;
    } catch (error) {
      if (error instanceof HttpException) {
        const body = error.getResponse();
        if (
          typeof body === 'object' &&
          body !== null &&
          'retryAfterSeconds' in body &&
          typeof body.retryAfterSeconds === 'number' &&
          Number.isSafeInteger(body.retryAfterSeconds)
        )
          response.setHeader('Retry-After', String(body.retryAfterSeconds));
      }
      throw error;
    }
  }

  private requireCsrf(
    cookie: string | undefined,
    csrfHeader: string | undefined,
  ): void {
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
  }

  private applyReplayHeader(response: Response, replayed: boolean): void {
    if (replayed) response.setHeader('Idempotency-Replayed', 'true');
  }
}
