import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AuthenticationApplicationService,
  readCookie,
  validCsrfPair,
} from '../application/authentication/authentication.application.service';
import { OrganizationProvisioningService } from '../application/organizations/organization-provisioning.service';

function parseOrganizationBody(body: unknown): { name: string; slug: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['name', 'slug'].includes(key)) ||
    typeof record.name !== 'string' ||
    typeof record.slug !== 'string'
  )
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  const name = record.name.trim();
  const slug = record.slug.trim().toLowerCase();
  if (
    name.length < 1 ||
    name.length > 200 ||
    slug.length < 1 ||
    slug.length > 100 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  )
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  return { name, slug };
}

@Controller('iam/organizations')
export class AccountOrganizationController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly organizations: OrganizationProvisioningService,
  ) {}

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
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
    return this.organizations.createSelfService(
      actor,
      parseOrganizationBody(body),
    );
  }
}
