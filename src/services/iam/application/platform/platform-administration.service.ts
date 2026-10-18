import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { normalizeMembershipEmail } from '../organizations/organization-membership-command.service';
import {
  ORGANIZATION_MEMBERSHIP_COMMAND_REPOSITORY,
  type AdminInvitationPage,
  type PlatformInvitationCommandInput,
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
  type PlatformUserListInput,
  type PlatformUserOrganizationsInput,
  type PlatformUserStatusChangeInput,
  type PlatformUserProfileChangeInput,
  type PlatformUserArchiveInput,
  type PlatformUserRestoreInput,
  type PlatformProjectListInput,
  type PlatformProjectMembershipListInput,
  type PlatformProjectMetadataChangeInput,
  type PlatformOrganizationMetadataChangeInput,
  type PlatformMembershipListInput,
  type PlatformSessionListInput,
  type PlatformSessionMutationInput,
  type PlatformSessionVersionInput,
  type PlatformRevokeSessionsInput,
} from './platform-administration.repository';
import type { RoleCode, UserStatus } from '../users/user-directory.repository';

const resourceIdPattern = /^[a-f\d]{24}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const userStatuses: readonly UserStatus[] = [
  'ACTIVE',
  'SUSPENDED',
  'PENDING_INVITE',
];
const userListStatuses = [...userStatuses, 'ARCHIVED'] as const;
const roleCodes: readonly RoleCode[] = ['ADMIN', 'TEAM_LEADER', 'MEMBER'];
const projectVisibilities = ['PRIVATE', 'PUBLIC'] as const;
const projectStatuses = ['ACTIVE', 'ARCHIVED'] as const;
const sessionStatuses = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
const sessionIdPattern =
  /^(?:[a-f\d]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const sessionReasons = ['SECURITY_INCIDENT', 'ACCESS_REVIEW'] as const;

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

  listUsers(input: PlatformUserListInput) {
    validatePage(input.page, input.pageSize);
    if (
      (input.search !== undefined &&
        (typeof input.search !== 'string' ||
          input.search.trim().length < 1 ||
          input.search.trim().length > 100)) ||
      (input.status !== undefined &&
        !userListStatuses.includes(input.status)) ||
      (input.organizationId !== undefined &&
        !resourceIdPattern.test(input.organizationId)) ||
      (input.roleCode !== undefined && !roleCodes.includes(input.roleCode))
    )
      validationFailed();
    return this.repository.listUsers({
      ...input,
      ...(input.search === undefined ? {} : { search: input.search.trim() }),
    });
  }

  async findUser(id: string) {
    if (!resourceIdPattern.test(id)) validationFailed();
    const user = await this.repository.findUser(id);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return user;
  }

  async listUserOrganizations(input: PlatformUserOrganizationsInput) {
    if (!resourceIdPattern.test(input.userId)) validationFailed();
    validatePage(input.page, input.pageSize);
    if (
      input.status !== undefined &&
      !ORGANIZATION_MEMBERSHIP_STATUSES.includes(input.status)
    )
      validationFailed();
    const page = await this.repository.listUserOrganizations(input);
    if (!page) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return page;
  }

  async changeUserStatus(input: PlatformUserStatusChangeInput) {
    if (
      !resourceIdPattern.test(input.actorUserId) ||
      !resourceIdPattern.test(input.userId) ||
      !['ACTIVE', 'SUSPENDED'].includes(input.status) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(input.reasonCode) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      validationFailed();
    const user = await this.repository.changeUserStatus(input);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return user;
  }

  async updateUserProfile(input: PlatformUserProfileChangeInput) {
    if (
      !resourceIdPattern.test(input.actorUserId) ||
      !resourceIdPattern.test(input.userId) ||
      (input.fullName === undefined && input.avatarUrl === undefined) ||
      (input.fullName !== undefined &&
        (typeof input.fullName !== 'string' ||
          input.fullName.trim().length < 1 ||
          input.fullName.trim().length > 200)) ||
      (input.avatarUrl !== undefined &&
        input.avatarUrl !== null &&
        !isSafeProfileAvatarUrl(input.avatarUrl)) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      validationFailed();
    const user = await this.repository.updateUserProfile(input);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return user;
  }

  async archiveUser(input: PlatformUserArchiveInput) {
    if (
      !resourceIdPattern.test(input.actorUserId) ||
      !resourceIdPattern.test(input.userId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !['SECURITY_INCIDENT', 'ACCESS_REVIEW'].includes(input.reasonCode) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      validationFailed();
    const user = await this.repository.archiveUser(input);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return user;
  }

  async restoreUser(input: PlatformUserRestoreInput) {
    if (
      !resourceIdPattern.test(input.actorUserId) ||
      !resourceIdPattern.test(input.userId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      input.reasonCode !== 'ACCESS_REVIEW' ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      validationFailed();
    const user = await this.repository.restoreUser(input);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return user;
  }

  listProjects(input: PlatformProjectListInput) {
    validatePage(input.page, input.pageSize);
    if (
      (input.search !== undefined &&
        (typeof input.search !== 'string' ||
          input.search.trim().length < 1 ||
          input.search.trim().length > 100)) ||
      (input.organizationId !== undefined &&
        !resourceIdPattern.test(input.organizationId)) ||
      (input.visibility !== undefined &&
        !projectVisibilities.includes(input.visibility)) ||
      (input.status !== undefined && !projectStatuses.includes(input.status))
    )
      validationFailed();
    return this.repository.listProjects({
      ...input,
      ...(input.search === undefined ? {} : { search: input.search.trim() }),
    });
  }

  async findProject(id: string) {
    if (!resourceIdPattern.test(id)) validationFailed();
    const project = await this.repository.findProject(id);
    if (!project) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND' });
    return project;
  }

  async listProjectMemberships(
    input: Omit<PlatformProjectMembershipListInput, 'organizationId'>,
  ) {
    if (
      !resourceIdPattern.test(input.projectId) ||
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > 100 ||
      (input.search !== undefined &&
        (typeof input.search !== 'string' ||
          input.search.trim().length < 1 ||
          input.search.trim().length > 100)) ||
      (input.status !== undefined &&
        !['ACTIVE', 'INACTIVE'].includes(input.status))
    )
      validationFailed();
    const project = await this.findProject(input.projectId);
    return this.repository.listProjectMemberships({
      ...input,
      organizationId: project.organization.id,
      ...(input.search === undefined ? {} : { search: input.search.trim() }),
    });
  }

  async changeProjectMetadata(input: PlatformProjectMetadataChangeInput) {
    if (
      !resourceIdPattern.test(input.actorUserId) ||
      !resourceIdPattern.test(input.projectId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime()) ||
      !['ACCESS_REVIEW', 'SECURITY_INCIDENT'].includes(input.reasonCode) ||
      (input.name === undefined &&
        input.code === undefined &&
        input.visibility === undefined) ||
      (input.name !== undefined &&
        (typeof input.name !== 'string' ||
          input.name.trim().length < 1 ||
          input.name.trim().length > 200)) ||
      (input.code !== undefined &&
        (typeof input.code !== 'string' ||
          !/^[A-Z][A-Z0-9_-]{1,31}$/.test(input.code))) ||
      (input.visibility !== undefined &&
        !projectVisibilities.includes(input.visibility))
    )
      validationFailed();
    const project = await this.repository.changeProjectMetadata({
      ...input,
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
    });
    if (!project) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND' });
    return project;
  }

  getDashboardSummary(now = new Date()) {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      validationFailed();
    return this.repository.getDashboardSummary(now);
  }

  async listUserSessions(input: PlatformSessionListInput) {
    if (!resourceIdPattern.test(input.userId)) validationFailed();
    validatePage(input.page, input.pageSize);
    if (input.status !== undefined && !sessionStatuses.includes(input.status))
      validationFailed();
    const page = await this.repository.listUserSessions(input);
    if (!page) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return page;
  }

  async findUserSession(userId: string, sessionId: string) {
    if (!resourceIdPattern.test(userId) || !sessionIdPattern.test(sessionId))
      validationFailed();
    const session = await this.repository.findUserSession(userId, sessionId);
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    return session;
  }

  async revokeUserSession(
    input: PlatformSessionMutationInput & PlatformSessionVersionInput,
  ) {
    this.validateSessionMutation(input);
    if (!sessionIdPattern.test(input.sessionId)) validationFailed();
    const session = await this.repository.revokeUserSession(input);
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    return session;
  }

  async revokeUserSessions(input: PlatformRevokeSessionsInput) {
    this.validateSessionMutation(input);
    if (
      !Array.isArray(input.sessions) ||
      input.sessions.length < 1 ||
      input.sessions.length > 100
    )
      validationFailed();
    const seen = new Set<string>();
    for (const session of input.sessions) {
      if (
        !sessionIdPattern.test(session.sessionId) ||
        seen.has(session.sessionId) ||
        !(session.expectedUpdatedAt instanceof Date) ||
        !Number.isFinite(session.expectedUpdatedAt.getTime())
      )
        validationFailed();
      seen.add(session.sessionId);
    }
    const result = await this.repository.revokeUserSessions(input);
    if (!result) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return result;
  }

  async revokeAllUserSessions(input: PlatformSessionMutationInput) {
    this.validateSessionMutation(input);
    const revokedCount = await this.repository.revokeAllUserSessions(input);
    if (revokedCount === null)
      throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return { revokedCount };
  }

  private validateSessionMutation(input: PlatformSessionMutationInput) {
    if (
      !resourceIdPattern.test(input.actorUserId) ||
      !resourceIdPattern.test(input.userId) ||
      !sessionReasons.includes(input.reasonCode) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime()) ||
      (input.correlationId !== undefined &&
        (typeof input.correlationId !== 'string' ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(input.correlationId)))
    )
      validationFailed();
  }

  async findOrganization(id: string) {
    if (!resourceIdPattern.test(id)) validationFailed();
    const organization = await this.repository.findOrganization(id);
    if (!organization)
      throw new NotFoundException({ code: 'ORGANIZATION_NOT_FOUND' });
    return organization;
  }

  async changeOrganizationMetadata(
    input: PlatformOrganizationMetadataChangeInput,
  ) {
    if (
      !resourceIdPattern.test(input.actorUserId) ||
      !resourceIdPattern.test(input.organizationId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime()) ||
      !['ACCESS_REVIEW', 'SECURITY_INCIDENT'].includes(input.reasonCode) ||
      (input.name === undefined && input.slug === undefined) ||
      (input.name !== undefined &&
        (typeof input.name !== 'string' ||
          input.name.trim().length < 1 ||
          input.name.trim().length > 200)) ||
      (input.slug !== undefined &&
        (typeof input.slug !== 'string' ||
          input.slug.length > 100 ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)))
    )
      validationFailed();
    const organization = await this.repository.changeOrganizationMetadata({
      ...input,
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
    });
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

  async listPlatformInvitations(input: {
    organizationId: string;
    page: number;
    pageSize: number;
  }): Promise<AdminInvitationPage> {
    if (!resourceIdPattern.test(input.organizationId)) validationFailed();
    validatePage(input.page, input.pageSize);
    await this.findOrganization(input.organizationId);
    return this.membershipCommands.listInvitations(
      input.organizationId,
      input.page,
      input.pageSize,
      new Date(),
    );
  }

  executePlatformInvitationCommand(
    input: Omit<PlatformInvitationCommandInput, 'now'>,
  ): Promise<MembershipMutationResult> {
    if (
      !resourceIdPattern.test(input.actorUserId) ||
      !resourceIdPattern.test(input.organizationId) ||
      !idempotencyPattern.test(input.idempotencyKey) ||
      (input.correlationId !== undefined &&
        !/^[A-Za-z0-9._:-]{1,128}$/.test(input.correlationId))
    )
      validationFailed();
    const command = input.command;
    if (command.command === 'INVITE') {
      if (
        !['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(command.reasonCode) ||
        Object.keys(command).length !== 3
      )
        validationFailed();
      return this.membershipCommands.executePlatformInvitationCommand({
        ...input,
        command: {
          ...command,
          email: normalizeMembershipEmail(command.email),
        },
        now: new Date(),
      });
    }
    if (
      (command.command !== 'RESEND' && command.command !== 'CANCEL') ||
      !resourceIdPattern.test(command.invitationId) ||
      !Number.isSafeInteger(command.expectedMembershipVersion) ||
      command.expectedMembershipVersion < 1 ||
      !Number.isSafeInteger(command.expectedInvitationVersion) ||
      command.expectedInvitationVersion < 1 ||
      (command.command === 'RESEND' &&
        !['ACCESS_REQUEST', 'ACCESS_REVIEW'].includes(command.reasonCode)) ||
      (command.command === 'CANCEL' &&
        command.reasonCode !== 'INVITATION_CANCELLED') ||
      Object.keys(command).length !== 5
    )
      validationFailed();
    return this.membershipCommands.executePlatformInvitationCommand({
      ...input,
      command,
      now: new Date(),
    });
  }

  listPlatformMemberships(input: PlatformMembershipListInput) {
    validatePage(input.page, input.pageSize);
    if (
      (input.search !== undefined &&
        (typeof input.search !== 'string' ||
          input.search.trim().length < 1 ||
          input.search.trim().length > 100)) ||
      (input.status !== undefined &&
        !ORGANIZATION_MEMBERSHIP_STATUSES.includes(input.status)) ||
      (input.organizationId !== undefined &&
        !resourceIdPattern.test(input.organizationId)) ||
      (input.roleCode !== undefined && !roleCodes.includes(input.roleCode))
    )
      validationFailed();
    return this.repository.listPlatformMemberships({
      ...input,
      ...(input.search === undefined ? {} : { search: input.search.trim() }),
    });
  }

  async findPlatformMembership(id: string) {
    if (!resourceIdPattern.test(id)) validationFailed();
    const membership = await this.repository.findPlatformMembership(id);
    if (!membership)
      throw new NotFoundException({ code: 'MEMBERSHIP_NOT_FOUND' });
    return membership;
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

function isSafeProfileAvatarUrl(value: string): boolean {
  if (value.length > 2000) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}
