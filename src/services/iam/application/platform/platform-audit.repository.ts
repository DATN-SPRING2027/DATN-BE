export const PLATFORM_AUDIT_REPOSITORY = Symbol('PLATFORM_AUDIT_REPOSITORY');

export interface PlatformOperationalAuditRecord {
  action:
    | 'organization.create'
    | 'platform.authority.granted'
    | 'platform.authority.revoked'
    | 'ORGANIZATION_MEMBERSHIP_SUSPENDED';
  targetResource:
    'ORGANIZATION' | 'PLATFORM_AUTHORITY' | 'ORGANIZATION_MEMBERSHIP';
  targetResourceId: string;
  actorUserId: string;
  occurredAt: string;
}

export interface PlatformAuditRepository {
  listOperationalMetadata(): Promise<PlatformOperationalAuditRecord[]>;
}
