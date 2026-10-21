import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpCode,
  Param,
  Patch,
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

function parseExpectedMembershipVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    return validationFailed();
  return Number(value);
}

function parseReason(value: unknown): string {
  if (typeof value !== 'string' || !reasonCodes.has(value))
    return validationFailed();
  return value;
}

const allowedInviteKeys = new Set([
  'email',
  'reasonCode',
  'roleCode',
  'accessScope',
  'projectIds',
  'message',
  'expiresInDays',
  'requireApproval',
]);
const allowedInviteRoleCodes = new Set(['ADMIN', 'MEMBER']);
const allowedInviteAccessScopes = new Set([
  'ORGANIZATION',
  'SPECIFIC_PROJECTS',
]);
const allowedInviteExpiryDays = new Set([7, 14, 30]);

function parseInvite(body: unknown): OrganizationMembershipCommand {
  const record = parseObject(body);
  const keys = Object.keys(record);
  if (
    keys.length < 2 ||
    keys.some((key) => !allowedInviteKeys.has(key)) ||
    typeof record.email !== 'string' ||
    !['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(
      parseReason(record.reasonCode),
    )
  )
    return validationFailed();

  let roleCode: 'ADMIN' | 'MEMBER' | undefined;
  if (record.roleCode !== undefined) {
    if (
      typeof record.roleCode !== 'string' ||
      !allowedInviteRoleCodes.has(record.roleCode)
    )
      return validationFailed();
    roleCode = record.roleCode as 'ADMIN' | 'MEMBER';
  }

  let accessScope: 'ORGANIZATION' | 'SPECIFIC_PROJECTS' | undefined;
  if (record.accessScope !== undefined) {
    if (
      typeof record.accessScope !== 'string' ||
      !allowedInviteAccessScopes.has(record.accessScope)
    )
      return validationFailed();
    accessScope = record.accessScope as 'ORGANIZATION' | 'SPECIFIC_PROJECTS';
  }

  let projectIds: string[] | undefined;
  if (record.projectIds !== undefined) {
    if (
      !Array.isArray(record.projectIds) ||
      record.projectIds.length === 0 ||
      record.projectIds.length > 50 ||
      record.projectIds.some(
        (id) => typeof id !== 'string' || !objectIdPattern.test(id),
      )
    )
      return validationFailed();
    projectIds = [...new Set(record.projectIds as string[])];
  }
  if (
    accessScope === 'SPECIFIC_PROJECTS' &&
    (!projectIds || projectIds.length === 0)
  )
    return validationFailed();

  let message: string | undefined;
  if (record.message !== undefined) {
    if (typeof record.message !== 'string' || record.message.length > 500)
      return validationFailed();
    const trimmed = record.message.trim();
    if (trimmed.length > 0) message = trimmed;
  }

  let expiresInDays: 7 | 14 | 30 | undefined;
  if (record.expiresInDays !== undefined) {
    if (
      typeof record.expiresInDays !== 'number' ||
      !allowedInviteExpiryDays.has(record.expiresInDays)
    )
      return validationFailed();
    expiresInDays = record.expiresInDays as 7 | 14 | 30;
  }

  let requireApproval: boolean | undefined;
  if (record.requireApproval !== undefined) {
    if (typeof record.requireApproval !== 'boolean') return validationFailed();
    requireApproval = record.requireApproval;
  }

  return {
    command: 'INVITE',
    email: record.email,
    reasonCode: record.reasonCode as 'ACCESS_REQUEST' | 'ACCESS_REVIEW',
    ...(roleCode ? { roleCode } : {}),
    ...(accessScope ? { accessScope } : {}),
    ...(projectIds ? { projectIds } : {}),
    ...(message ? { message } : {}),
    ...(expiresInDays ? { expiresInDays } : {}),
    ...(requireApproval !== undefined ? { requireApproval } : {}),
  };
}

function parseInvitationAction(
  body: unknown,
  invitationId: string,
  command: 'RESEND' | 'CANCEL',
): OrganizationMembershipCommand {
  if (!objectIdPattern.test(invitationId)) return validationFailed();
  const record = parseObject(body);
  const expectedKeys = [
    'expectedMembershipVersion',
    'expectedInvitationVersion',
    'reasonCode',
  ];
  if (!exactKeys(record, expectedKeys)) return validationFailed();
  const membershipVersion = parseExpectedMembershipVersion(
    record.expectedMembershipVersion,
  );
  const invitationVersion = parseVersion(record.expectedInvitationVersion);
  const reasonCode = parseReason(record.reasonCode);
  if (command === 'RESEND') {
    if (!['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(reasonCode))
      return validationFailed();
    return {
      command,
      invitationId,
      expectedMembershipVersion: membershipVersion,
      expectedInvitationVersion: invitationVersion,
      reasonCode: reasonCode as 'ACCESS_REQUEST' | 'ACCESS_REVIEW',
    };
  }
  if (reasonCode !== 'INVITATION_CANCELLED') return validationFailed();
  return {
    command,
    invitationId,
    expectedMembershipVersion: membershipVersion,
    expectedInvitationVersion: invitationVersion,
    reasonCode,
  };
}

function parseLifecycleAction(
  body: unknown,
  membershipId: string,
  command: 'SUSPEND' | 'RESUME' | 'REMOVE',
): OrganizationMembershipCommand {
  if (!objectIdPattern.test(membershipId)) return validationFailed();
  const record = parseObject(body);
  if (!exactKeys(record, ['expectedMembershipVersion', 'reasonCode']))
    return validationFailed();
  const reasonCode = parseReason(record.reasonCode);
  const expectedMembershipVersion = parseVersion(
    record.expectedMembershipVersion,
  );
  if (command === 'SUSPEND') {
    if (!['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(reasonCode))
      return validationFailed();
    return {
      command,
      membershipId,
      expectedMembershipVersion,
      reasonCode: reasonCode as 'SECURITY_INCIDENT' | 'ACCESS_REVIEW',
    };
  }
  if (
    !['SECURITY_INCIDENT', 'ACCESS_REVIEW', 'ACCESS_REQUEST'].includes(
      reasonCode,
    )
  )
    return validationFailed();
  return {
    command,
    membershipId,
    expectedMembershipVersion,
    reasonCode: reasonCode as
      'SECURITY_INCIDENT' | 'ACCESS_REVIEW' | 'ACCESS_REQUEST',
  };
}

function parseOrganizationSettingsUpdate(body: unknown): {
  expectedUpdatedAt: Date;
  name?: string;
  description?: string | null;
} {
  const record = parseObject(body);
  const keys = Object.keys(record);
  if (
    keys.length < 2 ||
    keys.some(
      (key) => !['expectedUpdatedAt', 'name', 'description'].includes(key),
    ) ||
    !('expectedUpdatedAt' in record) ||
    (!('name' in record) && !('description' in record)) ||
    typeof record.expectedUpdatedAt !== 'string'
  )
    return validationFailed();
  const expectedUpdatedAt = new Date(record.expectedUpdatedAt);
  if (
    !Number.isFinite(expectedUpdatedAt.getTime()) ||
    expectedUpdatedAt.toISOString() !== record.expectedUpdatedAt
  )
    return validationFailed();
  let name: string | undefined;
  if ('name' in record) {
    if (typeof record.name !== 'string') return validationFailed();
    const trimmed = record.name.trim();
    if (trimmed.length < 2 || trimmed.length > 100) return validationFailed();
    name = trimmed;
  }
  let description: string | null | undefined;
  if ('description' in record) {
    if (record.description === null) {
      description = null;
    } else if (typeof record.description === 'string') {
      if (record.description.length > 500) return validationFailed();
      const trimmed = record.description.trim();
      description = trimmed.length === 0 ? null : trimmed;
    } else {
      return validationFailed();
    }
  }
  return {
    expectedUpdatedAt,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
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

  @Get('overview')
  async getOverview(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('organizationId') organizationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.commands.getOverview(actor, organizationId);
  }

  @Get('settings')
  async getSettings(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('organizationId') organizationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.commands.getSettings(actor, organizationId);
  }

  @Patch('settings')
  async updateSettings(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-request-id') correlationId: string | undefined,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Req() request: (Request & { requestId?: string }) | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    this.requireCsrf(cookie, csrfHeader);
    return this.commands.updateSettings(actor, organizationId, {
      ...parseOrganizationSettingsUpdate(body),
      ...((request?.requestId ?? correlationId)
        ? { correlationId: request?.requestId ?? correlationId }
        : {}),
    });
  }

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
      () => parseLifecycleAction(body, membershipId, 'SUSPEND'),
      response,
    );
  }

  @Post('memberships/:membershipId/resume')
  @HttpCode(200)
  async resume(
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
      () => parseLifecycleAction(body, membershipId, 'RESUME'),
      response,
    );
  }

  @Post('memberships/:membershipId/remove')
  @HttpCode(200)
  async remove(
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
      () => parseLifecycleAction(body, membershipId, 'REMOVE'),
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
