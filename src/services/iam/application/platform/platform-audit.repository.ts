export const PLATFORM_AUDIT_REPOSITORY = Symbol('PLATFORM_AUDIT_REPOSITORY');

export interface PlatformOperationalAuditRecord {
  action:
    | 'organization.create'
    | 'platform.authority.granted'
    | 'platform.authority.revoked'
    | 'platform.user.status.changed'
    | 'platform.user.profile.updated'
    | 'platform.user.archived'
    | 'platform.session.revoked'
    | 'platform.sessions.revoked_all'
    | 'platform.incident.created'
    | 'platform.incident.acknowledged'
    | 'platform.incident.resolved'
    | 'platform.incident.note.added'
    | 'platform.job.retry'
    | 'platform.job.cancel'
    | 'platform.organization.metadata.changed'
    | 'platform.project.metadata.changed'
    | 'ORGANIZATION_MEMBERSHIP_SUSPENDED';
  targetResource:
    | 'ORGANIZATION'
    | 'PLATFORM_AUTHORITY'
    | 'ORGANIZATION_MEMBERSHIP'
    | 'USER'
    | 'PROJECT'
    | 'SESSION'
    | 'INCIDENT'
    | 'JOB';
  targetResourceId: string;
  actorUserId: string;
  occurredAt: string;
}

export type PlatformAuditAction =
  | PlatformOperationalAuditRecord['action']
  | 'platform.organization.metadata.changed'
  | 'platform.project.metadata.changed';
export type PlatformAuditResourceType =
  | 'ORGANIZATION'
  | 'PLATFORM_AUTHORITY'
  | 'ORGANIZATION_MEMBERSHIP'
  | 'USER'
  | 'PROJECT'
  | 'SESSION'
  | 'INCIDENT'
  | 'JOB';

export interface PlatformAuditEvent {
  eventId: string;
  occurredAt: string;
  actorUserId: string;
  action: PlatformAuditAction;
  resourceType: PlatformAuditResourceType;
  resourceId: string;
  scope: 'PLATFORM';
  result: 'SUCCESS';
  organizationId?: string;
  reasonCode?: string;
  requestId?: string;
  changes?: Record<
    string,
    {
      from: string | number | boolean | null;
      to: string | number | boolean | null;
    }
  >;
  changedFields?: Array<'fullName' | 'avatarUrl'>;
}

export interface PlatformAuditQuery {
  page: number;
  pageSize: number;
  actorUserId?: string;
  action?: PlatformAuditAction;
  resourceType?: PlatformAuditResourceType;
  resourceId?: string;
  organizationId?: string;
  from?: Date;
  to?: Date;
}

export interface PlatformAuditPage {
  data: PlatformAuditEvent[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface PlatformRequestTrace {
  requestId: string;
  events: PlatformAuditEvent[];
  truncated: boolean;
}

export interface PlatformAuditRepository {
  listOperationalMetadata(): Promise<PlatformOperationalAuditRecord[]>;
  listEvents(query: PlatformAuditQuery): Promise<PlatformAuditPage>;
  findRequestTrace(requestId: string): Promise<PlatformRequestTrace>;
  findEvent(eventId: string): Promise<PlatformAuditEvent | null>;
  listResourceHistory(input: {
    resourceType: PlatformAuditResourceType;
    resourceId: string;
    page: number;
    pageSize: number;
  }): Promise<PlatformAuditPage>;
}
