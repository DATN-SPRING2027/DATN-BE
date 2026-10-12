import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
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
import type { InvitationRoleCode } from '../application/organizations/organization-invitation.repository';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const roles = new Set<InvitationRoleCode>(['ADMIN', 'TEAM_LEADER', 'MEMBER']);

function parseOrganizationId(value: string): string {
  if (!OBJECT_ID_PATTERN.test(value))
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  return value;
}

function parseInvitationBody(body: unknown): {
  email: string;
  roleCode: InvitationRoleCode;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    Object.keys(record).some((key) => !['email', 'roleCode'].includes(key)) ||
    typeof record.email !== 'string' ||
    typeof record.roleCode !== 'string' ||
    !roles.has(record.roleCode as InvitationRoleCode)
  )
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  return {
    email: record.email,
    roleCode: record.roleCode as InvitationRoleCode,
  };
}

@Controller('iam/organizations')
export class OrganizationInvitationController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly invitations: OrganizationInvitationService,
  ) {}

  @Post(':organizationId/invitations')
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    return this.invitations.create(
      actor,
      parseOrganizationId(organizationId),
      parseInvitationBody(body),
    );
  }

  @Get(':organizationId/invitations')
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('organizationId') organizationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.invitations.listOrganization(
      actor,
      parseOrganizationId(organizationId),
    );
  }

  @Delete(':organizationId/invitations/:invitationId')
  @HttpCode(204)
  async revoke(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    await this.invitations.revoke(
      actor,
      parseOrganizationId(organizationId),
      invitationId,
    );
  }
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
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentSessionIdentity(
      authorization,
      cookie,
    );
    return this.invitations.listMine(actor);
  }

  @Post(':invitationId/accept')
  @HttpCode(200)
  async accept(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Param('invitationId') invitationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentSessionIdentity(
      authorization,
      cookie,
    );
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    return this.invitations.accept(actor, invitationId);
  }
}
