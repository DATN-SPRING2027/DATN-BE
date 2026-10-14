import {
  ForbiddenException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import {
  ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY,
  type AdminInvitationPage,
  type MembershipMutationResult,
  type OrganizationMembershipCommand,
  type OrganizationMembershipCommandRepository,
} from './organization-membership-command.repository';

const resourceIdPattern = /^[a-f\d]{24}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const allowedReasons = new Set([
  'ACCESS_REQUEST',
  'ACCESS_REVIEW',
  'INVITATION_CANCELLED',
  'SECURITY_INCIDENT',
]);

function validationFailed(): never {
  throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
}

export function normalizeMembershipEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    validationFailed();
  return normalized;
}

@Injectable()
export class OrganizationMembershipCommandService {
  constructor(
    @Inject(ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY)
    private readonly repository: OrganizationMembershipCommandRepository,
  ) {}

  async listInvitations(
    actor: AuthenticatedIdentity,
    organizationId: string,
    page: number,
    pageSize: number,
  ): Promise<AdminInvitationPage> {
    this.requireOrganizationContext(actor, organizationId);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      validationFailed();
    if (
      !(await this.repository.hasPermission(
        organizationId,
        actor.id,
        'organization.memberships.read',
      ))
    )
      throw new ForbiddenException({
        code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN',
      });
    return this.repository.listInvitations(
      organizationId,
      page,
      pageSize,
      new Date(),
    );
  }

  async execute(
    actor: AuthenticatedIdentity,
    organizationId: string,
    idempotencyKey: string,
    command: OrganizationMembershipCommand,
    correlationId?: string,
  ): Promise<MembershipMutationResult> {
    this.requireOrganizationContext(actor, organizationId);
    if (!idempotencyPattern.test(idempotencyKey)) validationFailed();
    const normalized = this.validateCommand(command);
    return this.repository.execute({
      actorUserId: actor.id,
      organizationId,
      idempotencyKey,
      command: normalized,
      now: new Date(),
      ...(correlationId ? { correlationId } : {}),
    });
  }

  private validateCommand(
    command: OrganizationMembershipCommand,
  ): OrganizationMembershipCommand {
    if (!command || typeof command !== 'object') validationFailed();
    if (command.command === 'INVITE') {
      if (
        Object.keys(command).length !== 3 ||
        !allowedReasons.has(command.reasonCode) ||
        !['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(command.reasonCode)
      )
        validationFailed();
      return { ...command, email: normalizeMembershipEmail(command.email) };
    }
    if (command.command === 'RESEND' || command.command === 'CANCEL') {
      if (
        Object.keys(command).length !== 5 ||
        !resourceIdPattern.test(command.invitationId) ||
        !Number.isSafeInteger(command.expectedMembershipVersion) ||
        command.expectedMembershipVersion < 1 ||
        !Number.isSafeInteger(command.expectedInvitationVersion) ||
        command.expectedInvitationVersion < 1
      )
        validationFailed();
      if (
        command.command === 'RESEND' &&
        !['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(command.reasonCode)
      )
        validationFailed();
      if (
        command.command === 'CANCEL' &&
        command.reasonCode !== 'INVITATION_CANCELLED'
      )
        validationFailed();
      return command;
    }
    if (command.command === 'SUSPEND') {
      if (
        Object.keys(command).length !== 4 ||
        !resourceIdPattern.test(command.membershipId) ||
        !Number.isSafeInteger(command.expectedMembershipVersion) ||
        command.expectedMembershipVersion < 1 ||
        !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(command.reasonCode)
      )
        validationFailed();
      return command;
    }
    return validationFailed();
  }

  private requireOrganizationContext(
    actor: AuthenticatedIdentity,
    organizationId: string,
  ): void {
    if (
      !resourceIdPattern.test(organizationId) ||
      actor.organizationId.toLowerCase() !== organizationId.toLowerCase()
    )
      throw new ForbiddenException({
        code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN',
      });
  }
}
