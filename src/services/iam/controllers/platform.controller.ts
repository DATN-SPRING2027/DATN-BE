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
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthResponse } from '../../../health/health.response';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import type { AuthenticatedPlatformSubject } from '../application/authentication/authentication.application.service';
import { PlatformAuthorizationGuard } from '../application/authorization/platform-authorization.guard';
import { RequirePlatformPermission } from '../application/authorization/platform-permission.decorator';
import type {
  OrganizationPlan,
  OrganizationProvisioningInput,
} from '../application/organizations/organization-provisioning.repository';
import { OrganizationProvisioningService } from '../application/organizations/organization-provisioning.service';
import { IamApplicationService } from '../application/iam.service';
import { PlatformAuditService } from '../application/platform/platform-audit.service';
import { PlatformAdministrationService } from '../application/platform/platform-administration.service';
import {
  ORGANIZATION_MEMBERSHIP_STATUSES,
  type OrganizationMembershipStatus,
} from '../application/organizations/organization-membership-read.repository';
import {
  readCookie,
  validCsrfPair,
} from '../application/authentication/authentication.application.service';

function invalid(): never {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed.',
  });
}

function parseOrganizationInput(body: unknown): OrganizationProvisioningInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    invalid();
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['name', 'slug', 'plan', 'firstAdminUserId'].includes(key),
    )
  )
    invalid();
  if (
    typeof record.name !== 'string' ||
    record.name.trim().length < 1 ||
    record.name.trim().length > 200 ||
    typeof record.slug !== 'string' ||
    record.slug.trim().length < 1 ||
    record.slug.trim().length > 100 ||
    typeof record.plan !== 'string' ||
    !['FREE', 'ENTERPRISE'].includes(record.plan) ||
    typeof record.firstAdminUserId !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(record.firstAdminUserId)
  )
    invalid();
  return {
    name: record.name.trim(),
    slug: record.slug.trim().toLowerCase(),
    plan: record.plan as OrganizationPlan,
    firstAdminUserId: record.firstAdminUserId,
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
    return invalid();
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    return invalid();
  return { page, pageSize };
}

function parseMembershipPageQuery(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
  status?: OrganizationMembershipStatus;
} {
  if (
    Object.keys(query).some(
      (key) => !['page', 'pageSize', 'status'].includes(key),
    ) ||
    (query.status !== undefined && typeof query.status !== 'string')
  )
    return invalid();
  const { page, pageSize } = parsePageQuery(
    Object.fromEntries(
      Object.entries(query).filter(([key]) => key !== 'status'),
    ),
  );
  if (
    query.status !== undefined &&
    !ORGANIZATION_MEMBERSHIP_STATUSES.includes(
      query.status as OrganizationMembershipStatus,
    )
  )
    return invalid();
  return {
    page,
    pageSize,
    ...(query.status !== undefined
      ? { status: query.status as OrganizationMembershipStatus }
      : {}),
  };
}

function parseUserLookup(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !('email' in body) ||
    typeof body.email !== 'string'
  )
    return invalid();
  return body.email;
}

function parsePlatformSuspend(body: unknown): {
  expectedMembershipVersion: number;
  reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
} {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    !('expectedMembershipVersion' in body) ||
    !('reasonCode' in body) ||
    !Number.isSafeInteger(body.expectedMembershipVersion) ||
    Number(body.expectedMembershipVersion) < 1 ||
    !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(String(body.reasonCode))
  )
    return invalid();
  return {
    expectedMembershipVersion: Number(body.expectedMembershipVersion),
    reasonCode: body.reasonCode as 'SECURITY_INCIDENT' | 'ACCESS_REVIEW',
  };
}

@Controller('iam/platform')
@UseGuards(PlatformAuthorizationGuard)
export class PlatformController {
  constructor(
    private readonly authentication: AuthenticationApplicationService,
    private readonly organizations: OrganizationProvisioningService,
    private readonly health: IamApplicationService,
    private readonly audit: PlatformAuditService,
    private readonly administration: PlatformAdministrationService,
  ) {}

  @Post('organizations')
  @RequirePlatformPermission('organization.create')
  async createOrganization(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const actor: AuthenticatedPlatformSubject =
      await this.authentication.getCurrentPlatformSubject(
        authorization,
        cookie,
      );
    return this.organizations.create(actor, parseOrganizationInput(body));
  }

  @Get('organizations')
  @RequirePlatformPermission('platform.organizations.organization.read')
  listOrganizations(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const { page, pageSize } = parsePageQuery(query);
    return this.administration.listOrganizations(page, pageSize);
  }

  @Get('organizations/:organizationId')
  @RequirePlatformPermission('platform.organizations.organization.read')
  findOrganization(
    @Param('organizationId') organizationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.findOrganization(organizationId);
  }

  @Post('users/lookup')
  @HttpCode(200)
  @RequirePlatformPermission('platform.users.account.read')
  async lookupUser(
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    return this.administration.lookupActiveUser(parseUserLookup(body));
  }

  @Get('organizations/:organizationId/memberships')
  @RequirePlatformPermission('platform.memberships.membership.read')
  listOrganizationMemberships(
    @Param('organizationId') organizationId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.administration.listOrganizationMemberships({
      organizationId,
      ...parseMembershipPageQuery(query),
    });
  }

  @Post('organizations/:organizationId/memberships/:membershipId/suspend')
  @HttpCode(200)
  @RequirePlatformPermission('platform.memberships.lifecycle.manage')
  async suspendMembership(
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
    response.setHeader('Cache-Control', 'no-store');
    if (!validCsrfPair(readCookie(cookie, '__Host-csrf'), csrfHeader))
      throw new ForbiddenException({ code: 'AUTH_CSRF_INVALID' });
    const actor = await this.authentication.getCurrentPlatformSubject(
      authorization,
      cookie,
    );
    const result = await this.administration.suspendMembership({
      actorUserId: actor.id,
      organizationId,
      membershipId,
      idempotencyKey: idempotencyKey ?? '',
      ...parsePlatformSuspend(body),
      ...(correlationId ? { correlationId } : {}),
    });
    response.status(result.httpStatus);
    response.setHeader('X-Idempotent-Replay', String(result.replayed));
    return result.body;
  }

  @Get('health')
  @RequirePlatformPermission('platform.health.read')
  @ApiOperation({
    summary: 'Read IAM process liveness',
    description:
      'Returns the existing IAM process liveness response only. It does not report MongoDB, Redis, BullMQ, or other dependency readiness.',
  })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.health.getHealth();
  }

  @Get('audit')
  @RequirePlatformPermission('platform.audit.read')
  listAudit(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.audit.listOperationalMetadata();
  }
}
