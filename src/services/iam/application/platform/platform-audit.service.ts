import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PLATFORM_AUDIT_REPOSITORY,
  type PlatformAuditAction,
  type PlatformAuditQuery,
  type PlatformAuditResourceType,
  type PlatformAuditRepository,
  type PlatformRequestTrace,
} from './platform-audit.repository';

const idPattern = /^[a-f\d]{24}$/i;
const jobResourceIdPattern =
  /^(?:ingestion-queue|jira-sync-queue|mail-queue|handover-queue|universe-projection|dlq-failed-jobs):[A-Za-z0-9._:-]{1,200}$/;
const actions: readonly PlatformAuditAction[] = [
  'organization.create',
  'platform.authority.granted',
  'platform.authority.revoked',
  'platform.user.status.changed',
  'platform.user.profile.updated',
  'platform.user.archived',
  'platform.user.restored',
  'platform.session.revoked',
  'platform.sessions.revoked_all',
  'ORGANIZATION_MEMBERSHIP_SUSPENDED',
  'platform.organization.metadata.changed',
  'platform.project.metadata.changed',
  'platform.incident.created',
  'platform.incident.acknowledged',
  'platform.incident.resolved',
  'platform.incident.note.added',
  'platform.job.retry',
  'platform.job.cancel',
];
const resourceTypes: readonly PlatformAuditResourceType[] = [
  'ORGANIZATION',
  'PLATFORM_AUTHORITY',
  'ORGANIZATION_MEMBERSHIP',
  'USER',
  'PROJECT',
  'SESSION',
  'INCIDENT',
  'JOB',
];

function validatePage(page: number, pageSize: number): void {
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
export class PlatformAuditService {
  constructor(
    @Inject(PLATFORM_AUDIT_REPOSITORY)
    private readonly repository: PlatformAuditRepository,
  ) {}

  listOperationalMetadata() {
    return this.repository.listOperationalMetadata();
  }

  listEvents(query: PlatformAuditQuery) {
    validatePage(query.page, query.pageSize);
    if (
      (query.actorUserId !== undefined && !idPattern.test(query.actorUserId)) ||
      (query.resourceId !== undefined &&
        !(query.resourceType === 'SESSION'
          ? /^(?:[a-f\d]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
              query.resourceId,
            )
          : query.resourceType === 'JOB'
            ? jobResourceIdPattern.test(query.resourceId)
            : idPattern.test(query.resourceId))) ||
      (query.organizationId !== undefined &&
        !idPattern.test(query.organizationId)) ||
      (query.action !== undefined && !actions.includes(query.action)) ||
      (query.resourceType !== undefined &&
        !resourceTypes.includes(query.resourceType)) ||
      (query.from !== undefined &&
        (!(query.from instanceof Date) ||
          !Number.isFinite(query.from.getTime()))) ||
      (query.to !== undefined &&
        (!(query.to instanceof Date) ||
          !Number.isFinite(query.to.getTime()))) ||
      (query.from !== undefined &&
        query.to !== undefined &&
        query.from.getTime() >= query.to.getTime())
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    return this.repository.listEvents(query);
  }

  async findRequestTrace(requestId: string): Promise<PlatformRequestTrace> {
    if (
      typeof requestId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    try {
      const trace = await this.repository.findRequestTrace(requestId);
      if (trace.events.length === 0)
        throw new NotFoundException({
          code: 'PLATFORM_REQUEST_TRACE_NOT_FOUND',
        });
      return trace;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof UnprocessableEntityException
      )
        throw error;
      throw new ServiceUnavailableException({
        code: 'PLATFORM_DIAGNOSTICS_UNAVAILABLE',
      });
    }
  }

  async findEvent(eventId: string) {
    if (!/^(?:[a-f\d]{24}|[A-Za-z0-9._:-]{1,128})$/i.test(eventId))
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    const event = await this.repository.findEvent(eventId);
    if (!event) throw new NotFoundException({ code: 'AUDIT_EVENT_NOT_FOUND' });
    return event;
  }

  listResourceHistory(input: {
    resourceType: PlatformAuditResourceType;
    resourceId: string;
    page: number;
    pageSize: number;
  }) {
    validatePage(input.page, input.pageSize);
    if (
      !resourceTypes.includes(input.resourceType) ||
      !(input.resourceType === 'SESSION'
        ? /^(?:[a-f\d]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
            input.resourceId,
          )
        : input.resourceType === 'JOB'
          ? jobResourceIdPattern.test(input.resourceId)
          : idPattern.test(input.resourceId))
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    return this.repository.listResourceHistory(input);
  }
}
