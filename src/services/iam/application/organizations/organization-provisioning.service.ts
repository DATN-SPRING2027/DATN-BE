import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedPlatformSubject } from '../authentication/authentication.application.service';
import {
  AUTH_SECURITY_STORE,
  type AuthSecurityStore,
} from '../authentication/auth-security.store';
import {
  ORGANIZATION_PROVISIONING_REPOSITORY,
  type OrganizationProvisioningInput,
  type OrganizationProvisioningRepository,
} from './organization-provisioning.repository';

@Injectable()
export class OrganizationProvisioningService {
  constructor(
    @Inject(ORGANIZATION_PROVISIONING_REPOSITORY)
    private readonly repository: OrganizationProvisioningRepository,
    @Inject(AUTH_SECURITY_STORE)
    private readonly security: AuthSecurityStore,
  ) {}

  async createSelfService(
    actor: AuthenticatedPlatformSubject,
    input: Pick<OrganizationProvisioningInput, 'name' | 'slug'>,
  ) {
    const allowed = await this.security.consumeRateLimit(
      `organization:create:${actor.id}`,
      3,
      3600,
    );
    if (!allowed) {
      throw new HttpException(
        {
          code: 'ORGANIZATION_CREATE_RATE_LIMITED',
          message: 'Too many creation attempts.',
        },
        429,
      );
    }
    return this.repository.create(actor.id, {
      name: input.name,
      slug: input.slug,
      plan: 'FREE',
      firstAdminUserId: actor.id,
    });
  }

  async checkSlugAvailability(slug: string): Promise<{
    slug: string;
    valid: boolean;
    available: boolean;
    reason?: 'INVALID_FORMAT' | 'TAKEN';
  }> {
    const normalized = slug.trim().toLowerCase();
    const isValidFormat =
      normalized.length >= 1 &&
      normalized.length <= 100 &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized);

    if (!isValidFormat) {
      return {
        slug: normalized,
        valid: false,
        available: false,
        reason: 'INVALID_FORMAT',
      };
    }

    const available = this.repository.isSlugAvailable
      ? await this.repository.isSlugAvailable(normalized)
      : true;

    return {
      slug: normalized,
      valid: true,
      available,
      ...(available ? {} : { reason: 'TAKEN' as const }),
    };
  }

  create(
    actor: AuthenticatedPlatformSubject,
    input: OrganizationProvisioningInput,
  ) {
    if (actor.id.toLowerCase() === input.firstAdminUserId.toLowerCase())
      throw new ConflictException({
        code: 'PLATFORM_OPERATOR_CANNOT_BE_FIRST_ADMIN',
        message:
          'The Platform Operator cannot be the first Organization ADMIN.',
      });
    return this.repository.create(actor.id, input);
  }
}
