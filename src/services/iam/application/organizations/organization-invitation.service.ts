import {
  Inject,
  Injectable,
  HttpException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  AuthenticatedAccountIdentity,
  AuthenticatedIdentity,
} from '../authentication/authentication.application.service';
import {
  ORGANIZATION_INVITATION_REPOSITORY,
  type OrganizationInvitationRepository,
} from './organization-invitation.repository';
import {
  areInvitationReadinessGatesReady,
  ORGANIZATION_INVITATION_READINESS,
  type OrganizationInvitationReadiness,
} from './organization-invitation-readiness';

type AccountActor = AuthenticatedIdentity | AuthenticatedAccountIdentity;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const objectIdPattern = /^[a-f\d]{24}$/i;
const invitationTokenPattern = /^[A-Za-z0-9_-]{43,128}$/;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;

export function normalizeInvitationEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !emailPattern.test(normalized))
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  return normalized;
}

function requirePage(page: number, pageSize: number): void {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
}

@Injectable()
export class OrganizationInvitationService {
  constructor(
    @Inject(ORGANIZATION_INVITATION_REPOSITORY)
    private readonly repository: OrganizationInvitationRepository,
    @Inject(ORGANIZATION_INVITATION_READINESS)
    private readonly invitationReadiness: OrganizationInvitationReadiness,
  ) {}

  async listMine(actor: AccountActor, page = 1, pageSize = 20) {
    requirePage(page, pageSize);
    return this.repository.listForRecipient(
      actor.id,
      normalizeInvitationEmail(actor.email),
      new Date(),
      page,
      pageSize,
    );
  }

  async getMine(actor: AccountActor, invitationId: string) {
    if (!objectIdPattern.test(invitationId))
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    const detail = await this.repository.getForRecipient(
      invitationId,
      actor.id,
      normalizeInvitationEmail(actor.email),
      new Date(),
    );
    if (!detail) throw new HttpException({ code: 'INVITATION_NOT_FOUND' }, 404);
    return detail;
  }

  async resolveToken(token: string) {
    if (typeof token !== 'string' || !invitationTokenPattern.test(token))
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const invitation = await this.repository.resolveByTokenHash(
      tokenHash,
      new Date(),
    );
    if (!invitation)
      throw new HttpException({ code: 'INVITATION_NOT_FOUND' }, 404);
    return invitation;
  }

  async accept(
    actor: AccountActor,
    invitationId: string,
    expectedMembershipVersion: number,
    expectedInvitationVersion: number,
    idempotencyKey: string,
  ) {
    if (
      !objectIdPattern.test(invitationId) ||
      !Number.isSafeInteger(expectedMembershipVersion) ||
      expectedMembershipVersion < 0 ||
      !Number.isSafeInteger(expectedInvitationVersion) ||
      expectedInvitationVersion < 1 ||
      !idempotencyPattern.test(idempotencyKey)
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    const authenticatedEmail = normalizeInvitationEmail(actor.email);
    const readinessReady = await areInvitationReadinessGatesReady(
      this.invitationReadiness,
      ['A7_LEGACY_OR_ORPHAN_RIGHTS_ACTIVATION_PROOF', 'A8_COORDINATED_CUTOVER'],
    );
    return this.repository.acceptForRecipient({
      invitationId,
      actorUserId: actor.id,
      authenticatedEmail,
      expectedMembershipVersion,
      expectedInvitationVersion,
      readinessReady,
      idempotencyKey,
      now: new Date(),
    });
  }
}
