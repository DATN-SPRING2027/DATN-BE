import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import { NotificationService } from '../../../notification/notification.service';
import {
  areInvitationReadinessGatesReady,
  ORGANIZATION_INVITATION_READINESS,
  type OrganizationInvitationReadiness,
  type OrganizationInvitationReadinessGate,
} from './organization-invitation-readiness';
import {
  ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY,
  type AdminInvitationPage,
  type MembershipMutationResult,
  type OrganizationMembershipCommand,
  type OrganizationMembershipCommandRepository,
  type OrganizationOverviewSummary,
  type OrganizationSettingsSummary,
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
    @Inject(ORGANIZATION_INVITATION_READINESS)
    private readonly invitationReadiness: OrganizationInvitationReadiness,
    @Optional()
    private readonly notificationService?: NotificationService,
  ) {}

  async getOverview(
    actor: AuthenticatedIdentity,
    organizationId: string,
  ): Promise<OrganizationOverviewSummary> {
    this.requireOrganizationContext(actor, organizationId);
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
    if (!this.repository.getOrganizationOverview)
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });
    return this.repository.getOrganizationOverview(organizationId, new Date());
  }

  async getSettings(
    actor: AuthenticatedIdentity,
    organizationId: string,
  ): Promise<OrganizationSettingsSummary> {
    this.requireOrganizationContext(actor, organizationId);
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
    if (!this.repository.getOrganizationSettings)
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });
    return this.repository.getOrganizationSettings(organizationId);
  }

  async updateSettings(
    actor: AuthenticatedIdentity,
    organizationId: string,
    input: {
      expectedUpdatedAt: Date;
      name?: string;
      description?: string | null;
      correlationId?: string;
    },
  ): Promise<OrganizationSettingsSummary> {
    this.requireOrganizationContext(actor, organizationId);
    if (
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      (input.name === undefined && input.description === undefined)
    )
      validationFailed();
    let normalizedName: string | undefined;
    if (input.name !== undefined) {
      if (typeof input.name !== 'string') validationFailed();
      const trimmed = input.name.trim();
      if (trimmed.length < 2 || trimmed.length > 100) validationFailed();
      normalizedName = trimmed;
    }
    let normalizedDescription: string | null | undefined;
    if (input.description !== undefined) {
      if (input.description === null) {
        normalizedDescription = null;
      } else if (typeof input.description === 'string') {
        if (input.description.length > 500) validationFailed();
        const trimmed = input.description.trim();
        normalizedDescription = trimmed.length === 0 ? null : trimmed;
      } else {
        validationFailed();
      }
    }
    if (
      !(await this.repository.hasPermission(
        organizationId,
        actor.id,
        'organization.memberships.manage',
      ))
    )
      throw new ForbiddenException({
        code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN',
      });
    if (!this.repository.updateOrganizationSettings)
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });
    return this.repository.updateOrganizationSettings({
      actorUserId: actor.id,
      organizationId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      ...(normalizedName !== undefined ? { name: normalizedName } : {}),
      ...(normalizedDescription !== undefined
        ? { description: normalizedDescription }
        : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      now: new Date(),
    });
  }

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
    const readinessGates = this.readinessGatesFor(normalized);
    let invitationReadinessReady: boolean | undefined;
    if (readinessGates) {
      if (
        !(await this.repository.hasPermission(
          organizationId,
          actor.id,
          'organization.memberships.manage',
        ))
      )
        throw new ForbiddenException({
          code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN',
        });
      invitationReadinessReady = await areInvitationReadinessGatesReady(
        this.invitationReadiness,
        readinessGates,
      );
    }
    const result = await this.repository.execute({
      actorUserId: actor.id,
      organizationId,
      idempotencyKey,
      command: normalized,
      now: new Date(),
      ...(invitationReadinessReady === undefined
        ? {}
        : { invitationReadinessReady }),
      ...(correlationId ? { correlationId } : {}),
    });

    if (!result.replayed && this.notificationService) {
      const bodyMembership =
        'membership' in result.body ? result.body.membership : undefined;
      if (
        (normalized.command === 'INVITE' || normalized.command === 'RESEND') &&
        result.body.invitation?.id
      ) {
        await this.notificationService.notifyOrganizationMemberInvited({
          actorId: actor.id,
          recipientUserId: bodyMembership?.userId ?? null,
          recipientEmail:
            normalized.command === 'INVITE' ? normalized.email : null,
          organizationId,
          invitationId: result.body.invitation.id,
        });
      } else if (normalized.command === 'RESUME' && bodyMembership?.userId) {
        await this.notificationService.notifyOrganizationMemberAdded({
          actorId: actor.id,
          recipientUserId: bodyMembership.userId,
          organizationId,
          eventId: `resume:${bodyMembership.id}:${bodyMembership.version}`,
        });
      } else if (
        (normalized.command === 'REMOVE' || normalized.command === 'SUSPEND') &&
        bodyMembership?.userId
      ) {
        await this.notificationService.notifyOrganizationMemberRemoved({
          actorId: actor.id,
          recipientUserId: bodyMembership.userId,
          organizationId,
          eventId: `${normalized.command.toLowerCase()}:${bodyMembership.id}:${bodyMembership.version}`,
        });
      }
    }

    return result;
  }

  private readinessGatesFor(
    command: OrganizationMembershipCommand,
  ): readonly OrganizationInvitationReadinessGate[] | undefined {
    if (command.command === 'INVITE' || command.command === 'RESEND')
      return ['A7_NOTIFICATION_CONTRACT_PROVIDER', 'A8_COORDINATED_CUTOVER'];
    if (command.command === 'CANCEL') return ['A8_COORDINATED_CUTOVER'];
    return undefined;
  }

  private validHandovers(handovers: unknown): boolean {
    if (handovers === undefined) return true;
    if (!Array.isArray(handovers) || handovers.length > 1000) return false;
    const projectIds = new Set<string>();
    for (const entry of handovers as unknown[]) {
      const item = entry as Record<string, unknown> | null;
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        Object.keys(item).length !== 2 ||
        typeof item.projectId !== 'string' ||
        typeof item.replacementUserId !== 'string' ||
        !resourceIdPattern.test(item.projectId) ||
        !resourceIdPattern.test(item.replacementUserId)
      )
        return false;
      projectIds.add(item.projectId.toLowerCase());
    }
    return projectIds.size === handovers.length;
  }

  private validateCommand(
    command: OrganizationMembershipCommand,
  ): OrganizationMembershipCommand {
    if (!command || typeof command !== 'object') validationFailed();
    if (command.command === 'INVITE') {
      const allowedKeys = new Set([
        'command',
        'email',
        'reasonCode',
        'roleCode',
        'projectRoleCode',
        'accessScope',
        'projectIds',
        'message',
        'expiresInDays',
        'requireApproval',
      ]);
      const keys = Object.keys(command);
      if (
        keys.length < 3 ||
        keys.some((key) => !allowedKeys.has(key)) ||
        !allowedReasons.has(command.reasonCode) ||
        !['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(command.reasonCode)
      )
        validationFailed();
      if (
        command.roleCode !== undefined &&
        command.roleCode !== 'ADMIN' &&
        command.roleCode !== 'MEMBER'
      )
        validationFailed();
      if (
        command.projectRoleCode !== undefined &&
        command.projectRoleCode !== 'TEAM_LEADER' &&
        command.projectRoleCode !== 'MEMBER'
      )
        validationFailed();
      if (
        command.accessScope !== undefined &&
        command.accessScope !== 'ORGANIZATION' &&
        command.accessScope !== 'SPECIFIC_PROJECTS'
      )
        validationFailed();
      let normalizedProjectIds: string[] | undefined;
      if (command.projectIds !== undefined) {
        if (
          !Array.isArray(command.projectIds) ||
          command.projectIds.length === 0 ||
          command.projectIds.length > 50 ||
          !command.projectIds.every(
            (id): id is string =>
              typeof id === 'string' && resourceIdPattern.test(id),
          )
        )
          validationFailed();
        normalizedProjectIds = [
          ...new Set(command.projectIds.map((id) => id.toLowerCase())),
        ];
      }
      if (
        command.accessScope === 'SPECIFIC_PROJECTS' &&
        (!normalizedProjectIds || normalizedProjectIds.length === 0)
      )
        validationFailed();
      if (
        command.projectRoleCode === 'TEAM_LEADER' &&
        (command.accessScope !== 'SPECIFIC_PROJECTS' ||
          !normalizedProjectIds?.length)
      )
        validationFailed();
      let normalizedMessage: string | undefined;
      if (command.message !== undefined) {
        if (typeof command.message !== 'string' || command.message.length > 500)
          validationFailed();
        const trimmed = command.message.trim();
        if (trimmed.length > 0) normalizedMessage = trimmed;
      }
      if (
        command.expiresInDays !== undefined &&
        command.expiresInDays !== 7 &&
        command.expiresInDays !== 14 &&
        command.expiresInDays !== 30
      )
        validationFailed();
      if (
        command.requireApproval !== undefined &&
        typeof command.requireApproval !== 'boolean'
      )
        validationFailed();
      return {
        command: 'INVITE',
        email: normalizeMembershipEmail(command.email),
        reasonCode: command.reasonCode,
        ...(command.roleCode ? { roleCode: command.roleCode } : {}),
        ...(command.projectRoleCode
          ? { projectRoleCode: command.projectRoleCode }
          : {}),
        ...(command.accessScope ? { accessScope: command.accessScope } : {}),
        ...(normalizedProjectIds ? { projectIds: normalizedProjectIds } : {}),
        ...(normalizedMessage ? { message: normalizedMessage } : {}),
        ...(command.expiresInDays
          ? { expiresInDays: command.expiresInDays }
          : {}),
        ...(command.requireApproval !== undefined
          ? { requireApproval: command.requireApproval }
          : {}),
      };
    }
    if (command.command === 'RESEND' || command.command === 'CANCEL') {
      if (
        Object.keys(command).length !== 5 ||
        !resourceIdPattern.test(command.invitationId) ||
        !Number.isSafeInteger(command.expectedMembershipVersion) ||
        command.expectedMembershipVersion < 0 ||
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
      const handovers = command.handovers;
      if (
        Object.keys(command).length !== (handovers === undefined ? 4 : 5) ||
        !resourceIdPattern.test(command.membershipId) ||
        !Number.isSafeInteger(command.expectedMembershipVersion) ||
        command.expectedMembershipVersion < 1 ||
        !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(command.reasonCode) ||
        !this.validHandovers(handovers)
      )
        validationFailed();
      return command;
    }
    if (command.command === 'RESUME' || command.command === 'REMOVE') {
      const handovers =
        command.command === 'REMOVE' ? command.handovers : undefined;
      if (
        Object.keys(command).length !== (handovers === undefined ? 4 : 5) ||
        !resourceIdPattern.test(command.membershipId) ||
        !Number.isSafeInteger(command.expectedMembershipVersion) ||
        command.expectedMembershipVersion < 1 ||
        !['SECURITY_INCIDENT', 'ACCESS_REVIEW', 'ACCESS_REQUEST'].includes(
          command.reasonCode,
        ) ||
        !this.validHandovers(handovers)
      )
        validationFailed();
      return command;
    }
    if (command.command === 'SET_ORGANIZATION_ROLE') {
      if (
        Object.keys(command).length !== 6 ||
        !resourceIdPattern.test(command.membershipId) ||
        !Number.isSafeInteger(command.expectedMembershipVersion) ||
        command.expectedMembershipVersion < 1 ||
        !Number.isSafeInteger(command.expectedRoleVersion) ||
        command.expectedRoleVersion < 0 ||
        !['ADMIN', 'MEMBER'].includes(command.roleCode) ||
        typeof command.reason !== 'string' ||
        command.reason.length > 500 ||
        command.reason.trim().length < 1 ||
        command.reason.trim().length > 500
      )
        validationFailed();
      return { ...command, reason: command.reason.trim() };
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
