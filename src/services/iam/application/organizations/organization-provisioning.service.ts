import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedPlatformSubject } from '../authentication/authentication.application.service';
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
  ) {}

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
