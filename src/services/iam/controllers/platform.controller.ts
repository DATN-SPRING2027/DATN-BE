import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
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

@Controller('iam/platform')
@UseGuards(PlatformAuthorizationGuard)
export class PlatformController {
  constructor(
    private readonly authentication: AuthenticationApplicationService,
    private readonly organizations: OrganizationProvisioningService,
    private readonly health: IamApplicationService,
    private readonly audit: PlatformAuditService,
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

  @Get('health')
  @RequirePlatformPermission('platform.health.read')
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
