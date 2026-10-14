import {
  Inject,
  Injectable,
  HttpException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AuthenticatedAccountIdentity,
  AuthenticatedIdentity,
} from '../authentication/authentication.application.service';
import {
  ORGANIZATION_INVITATION_REPOSITORY,
  type OrganizationInvitationRepository,
} from './organization-invitation.repository';

type AccountActor = AuthenticatedIdentity | AuthenticatedAccountIdentity;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const objectIdPattern = /^[a-f\d]{24}$/i;

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
}
