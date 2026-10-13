import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import { OrganizationMembershipReadService } from '../application/organizations/organization-membership-read.service';

@Controller('iam/organizations/:organizationId/memberships')
export class OrganizationMembershipReadController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly memberships: OrganizationMembershipReadService,
  ) {}
  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('organizationId') organizationId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.memberships.list(actor, organizationId, query);
  }
  @Get(':membershipId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('organizationId') organizationId: string,
    @Param('membershipId') membershipId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return this.memberships.get(actor, organizationId, membershipId, query);
  }
}
