export const PLATFORM_INCIDENT_REPOSITORY = Symbol(
  'PLATFORM_INCIDENT_REPOSITORY',
);

export const PLATFORM_INCIDENT_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'RESOLVED',
] as const;
export type PlatformIncidentStatus =
  (typeof PLATFORM_INCIDENT_STATUSES)[number];

export const PLATFORM_INCIDENT_SEVERITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;
export type PlatformIncidentSeverity =
  (typeof PLATFORM_INCIDENT_SEVERITIES)[number];

export interface PlatformIncidentSummary {
  id: string;
  title: string;
  severity: PlatformIncidentSeverity;
  status: PlatformIncidentStatus;
  affectedServiceId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface PlatformIncidentHistoryItem {
  id: string;
  incidentId: string;
  action: 'CREATED' | 'ACKNOWLEDGED' | 'RESOLVED' | 'NOTE_ADDED';
  fromStatus?: PlatformIncidentStatus;
  toStatus: PlatformIncidentStatus;
  version: number;
  actorUserId: string;
  occurredAt: string;
  note?: string;
}

export interface PlatformIncidentListInput {
  page: number;
  pageSize: number;
  status?: PlatformIncidentStatus;
  severity?: PlatformIncidentSeverity;
  affectedServiceId?: string;
}

export interface PlatformIncidentPage<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export type PlatformIncidentCommand =
  | {
      command: 'CREATE';
      title: string;
      severity: PlatformIncidentSeverity;
      affectedServiceId: string;
    }
  | {
      command: 'ACKNOWLEDGE' | 'RESOLVE' | 'ADD_NOTE';
      incidentId: string;
      expectedVersion: number;
      note: string;
    };

export interface PlatformIncidentCommandInput {
  actorUserId: string;
  idempotencyKey: string;
  command: PlatformIncidentCommand;
  now: Date;
  correlationId?: string;
}

export interface PlatformIncidentMutationResult {
  httpStatus: 200 | 201;
  replayed: boolean;
  body: PlatformIncidentSummary;
}

export interface PlatformIncidentRepository {
  list(
    input: PlatformIncidentListInput,
  ): Promise<PlatformIncidentPage<PlatformIncidentSummary>>;
  find(incidentId: string): Promise<PlatformIncidentSummary | null>;
  listHistory(input: {
    incidentId: string;
    page: number;
    pageSize: number;
  }): Promise<PlatformIncidentPage<PlatformIncidentHistoryItem>>;
  execute(
    input: PlatformIncidentCommandInput,
  ): Promise<PlatformIncidentMutationResult>;
}
