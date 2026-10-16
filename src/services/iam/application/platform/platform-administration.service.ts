import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { normalizeMembershipEmail } from '../organizations/organization-membership-command.service';
import {
  ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY,
  type MembershipMutationResult,
  type OrganizationMembershipCommandRepository,
} from '../organizations/organization-membership-command.repository';
import {
  ORGANIZATION_MEMBERSHIP_STATUSES,
  type OrganizationMembershipStatus,
} from '../organizations/organization-membership-read.repository';
import {
  PLATFORM_ADMINISTRATION_REPOSITORY,
  type PlatformAdministrationRepository,
} from './platform-administration.repository';

const resourceIdPattern = /^[a-f\d]{24}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;

function validationFailed(): never {
  throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
}

function validatePage(page: number, pageSize: number): void {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    validationFailed();
}

@Injectable()
export class PlatformAdministrationService {
  constructor(
    @Inject(PLATFORM_ADMINISTRATION_REPOSITORY)
    private readonly repository: PlatformAdministrationRepository,
    @Inject(ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY)
    private readonly membershipCommands: OrganizationMembershipCommandRepository,
  ) {}

  listOrganizations(page: number, pageSize: number) {
    validatePage(page, pageSize);
    return this.repository.listOrganizations(page, pageSize);
  }

  async findOrganization(id: string) {
    if (!resourceIdPattern.test(id)) validationFailed();
    const organization = await this.repository.findOrganization(id);
    if (!organization)
      throw new NotFoundException({ code: 'ORGANIZATION_NOT_FOUND' });
    return organization;
  }

  async lookupActiveUser(email: string) {
    if (typeof email !== 'string') validationFailed();
    const normalizedEmail = normalizeMembershipEmail(email);
    const user =
      await this.repository.findActiveUserByExactEmail(normalizedEmail);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return user;
  }

  async listOrganizationMemberships(input: {
    organizationId: string;
    page: number;
    pageSize: number;
    status?: OrganizationMembershipStatus;
  }) {
    if (!resourceIdPattern.test(input.organizationId)) validationFailed();
    validatePage(input.page, input.pageSize);
    if (
      input.status !== undefined &&
      !ORGANIZATION_MEMBERSHIP_STATUSES.includes(input.status)
    )
      validationFailed();
    await this.findOrganization(input.organizationId);
    return this.repository.listOrganizationMemberships(input);
  }

  suspendMembership(input: {
    actorUserId: string;
    organizationId: string;
    membershipId: string;
    idempotencyKey: string;
    expectedMembershipVersion: number;
    reasonCode: 'SECURITY_INCIDENT' | 'ACCESS_REVIEW';
    correlationId?: string;
  }): Promise<MembershipMutationResult> {
    if (
      !resourceIdPattern.test(input.actorUserId) ||
      !resourceIdPattern.test(input.organizationId) ||
      !resourceIdPattern.test(input.membershipId) ||
      !idempotencyPattern.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.expectedMembershipVersion) ||
      input.expectedMembershipVersion < 1 ||
      !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(input.reasonCode)
    )
      validationFailed();
    return this.membershipCommands.executePlatformSuspend({
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      idempotencyKey: input.idempotencyKey,
      expectedMembershipVersion: input.expectedMembershipVersion,
      reasonCode: input.reasonCode,
      now: new Date(),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
  }
}
