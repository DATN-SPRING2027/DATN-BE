import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import {
  ORGANIZATION_MEMBERSHIP_READ_REPOSITORY,
  ORGANIZATION_MEMBERSHIP_STATUSES,
  type OrganizationMembershipReadRepository,
  type OrganizationMembershipListQuery,
  type OrganizationMembershipStatus,
} from './organization-membership-read.repository';

const validId = (value: string) => /^[a-f\d]{24}$/i.test(value);
function invalid(field: string): never {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed.',
    details: { fields: [field] },
  });
}
function id(value: string, field: string): string {
  if (!validId(value)) invalid(field);
  return value.toLowerCase();
}
function queryObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('query');
  return value as Record<string, unknown>;
}
function positive(
  value: unknown,
  fallback: number,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) invalid(field);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) invalid(field);
  return number;
}
function parseList(value: unknown): OrganizationMembershipListQuery {
  const query = queryObject(value);
  if (
    Object.keys(query).some(
      (key) => !['page', 'pageSize', 'status'].includes(key),
    )
  )
    invalid('query');
  const page = positive(query.page, 1, 'page');
  const pageSize = positive(query.pageSize, 20, 'pageSize', 100);
  if (!Number.isSafeInteger((page - 1) * pageSize)) invalid('page');
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' ||
      !ORGANIZATION_MEMBERSHIP_STATUSES.includes(
        query.status as OrganizationMembershipStatus,
      ))
  )
    invalid('status');
  return {
    page,
    pageSize,
    ...(query.status === undefined
      ? {}
      : { status: query.status as OrganizationMembershipStatus }),
  };
}

@Injectable()
export class OrganizationMembershipReadService {
  constructor(
    @Inject(ORGANIZATION_MEMBERSHIP_READ_REPOSITORY)
    private readonly repository: OrganizationMembershipReadRepository,
  ) {}
  async list(
    actor: AuthenticatedIdentity,
    organizationId: string,
    query: unknown,
  ) {
    await this.authorize(actor, organizationId);
    const scope = id(organizationId, 'organizationId');
    const parsed = parseList(query);
    const result = await this.repository.list(scope, parsed);
    return {
      data: result.data,
      pagination: {
        page: parsed.page,
        pageSize: parsed.pageSize,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / parsed.pageSize),
      },
    };
  }
  async get(
    actor: AuthenticatedIdentity,
    organizationId: string,
    membershipId: string,
    query: unknown,
  ) {
    await this.authorize(actor, organizationId);
    const scope = id(organizationId, 'organizationId');
    const target = id(membershipId, 'membershipId');
    if (Object.keys(queryObject(query)).length) invalid('query');
    const member = await this.repository.find(scope, target);
    if (!member)
      throw new NotFoundException({
        code: 'ORGANIZATION_MEMBERSHIP_NOT_FOUND',
        message: 'Membership not found.',
      });
    return member;
  }
  private async authorize(
    actor: AuthenticatedIdentity,
    requestedOrganizationId: string,
  ): Promise<void> {
    const forbidden = () =>
      new ForbiddenException({
        code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN',
        message: 'Organization membership read access required.',
      });
    if (!validId(actor.id) || !validId(actor.organizationId)) throw forbidden();
    if (
      validId(requestedOrganizationId) &&
      requestedOrganizationId.toLowerCase() !==
        actor.organizationId.toLowerCase()
    )
      throw forbidden();
    if (
      !(await this.repository.hasReadAccess(
        actor.organizationId.toLowerCase(),
        actor.id.toLowerCase(),
      ))
    )
      throw forbidden();
  }
}
