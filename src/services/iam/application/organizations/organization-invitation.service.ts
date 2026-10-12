import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AUTH_SECURITY_STORE,
  type AuthSecurityStore,
} from '../authentication/auth-security.store';
import type {
  AuthenticatedAccountIdentity,
  AuthenticatedIdentity,
} from '../authentication/authentication.application.service';
import {
  ORGANIZATION_INVITATION_REPOSITORY,
  type InvitationRoleCode,
  type OrganizationInvitationRepository,
} from './organization-invitation.repository';

type AccountActor = AuthenticatedIdentity | AuthenticatedAccountIdentity;
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INVITATIONS_PER_LIST = 50;
const MAX_INVITATIONS_PER_HOUR = 30;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export function normalizeInvitationEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized))
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  return normalized;
}

@Injectable()
export class OrganizationInvitationService {
  constructor(
    @Inject(ORGANIZATION_INVITATION_REPOSITORY)
    private readonly repository: OrganizationInvitationRepository,
    @Inject(AUTH_SECURITY_STORE)
    private readonly security: AuthSecurityStore,
  ) {}

  async create(
    actor: AuthenticatedIdentity,
    organizationId: string,
    input: { email: string; roleCode: InvitationRoleCode },
  ) {
    this.requireOrganizationContext(actor, organizationId);
    await this.requireAdmin(actor, organizationId);
    if (
      !(await this.security.consumeRateLimit(
        `organization:invite:${organizationId}:${actor.id}`,
        MAX_INVITATIONS_PER_HOUR,
        3600,
      ))
    )
      throw new HttpException(
        { code: 'ORGANIZATION_INVITATION_RATE_LIMITED' },
        429,
      );
    if (!['ADMIN', 'TEAM_LEADER', 'MEMBER'].includes(input.roleCode))
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    return this.repository.create({
      organizationId,
      email: normalizeInvitationEmail(input.email),
      roleCode: input.roleCode,
      invitedBy: actor.id,
      expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
    });
  }

  async listOrganization(actor: AuthenticatedIdentity, organizationId: string) {
    this.requireOrganizationContext(actor, organizationId);
    await this.requireAdmin(actor, organizationId);
    return this.repository.listForOrganization(
      organizationId,
      new Date(),
      MAX_INVITATIONS_PER_LIST,
    );
  }

  async listMine(actor: AccountActor) {
    const email = normalizeInvitationEmail(actor.email);
    return this.repository.listForRecipient(
      email,
      new Date(),
      MAX_INVITATIONS_PER_LIST,
    );
  }

  async revoke(
    actor: AuthenticatedIdentity,
    organizationId: string,
    invitationId: string,
  ): Promise<void> {
    this.requireOrganizationContext(actor, organizationId);
    await this.requireAdmin(actor, organizationId);
    if (!OBJECT_ID_PATTERN.test(invitationId))
      throw new ConflictException({ code: 'INVITATION_NOT_REVOCABLE' });
    const revoked = await this.repository.revoke({
      invitationId,
      organizationId,
      actorUserId: actor.id,
      now: new Date(),
    });
    if (!revoked)
      throw new ConflictException({ code: 'INVITATION_NOT_REVOCABLE' });
  }

  async accept(actor: AccountActor, invitationId: string) {
    if (!OBJECT_ID_PATTERN.test(invitationId))
      throw new ConflictException({ code: 'INVITATION_NOT_ACCEPTABLE' });
    const accepted = await this.repository.accept({
      invitationId,
      userId: actor.id,
      email: normalizeInvitationEmail(actor.email),
      now: new Date(),
    });
    if (!accepted)
      throw new ConflictException({
        code: 'INVITATION_NOT_ACCEPTABLE',
        message: 'This invitation is unavailable for the signed-in account.',
      });
    return accepted;
  }

  private requireOrganizationContext(
    actor: AuthenticatedIdentity,
    organizationId: string,
  ): void {
    if (
      !OBJECT_ID_PATTERN.test(organizationId) ||
      actor.organizationId.toLowerCase() !== organizationId.toLowerCase()
    )
      throw new ForbiddenException({ code: 'ORGANIZATION_CONTEXT_REQUIRED' });
  }

  private async requireAdmin(
    actor: AuthenticatedIdentity,
    organizationId: string,
  ): Promise<void> {
    if (!(await this.repository.isOrganizationAdmin(organizationId, actor.id)))
      throw new ForbiddenException({ code: 'ORGANIZATION_ADMIN_REQUIRED' });
  }
}
