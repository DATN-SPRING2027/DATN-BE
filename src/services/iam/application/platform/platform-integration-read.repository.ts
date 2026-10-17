export const PLATFORM_INTEGRATION_READ_REPOSITORY = Symbol(
  'PLATFORM_INTEGRATION_READ_REPOSITORY',
);

export type PlatformIntegrationStatus = 'CONNECTED' | 'EXPIRED' | 'REVOKED';

export interface PlatformIntegrationListInput {
  page: number;
  pageSize: number;
  organizationId?: string;
  projectId?: string;
  status?: PlatformIntegrationStatus;
}

export interface PlatformIntegrationSummary {
  id: string;
  provider: 'JIRA';
  organizationId: string;
  projectId: string;
  status: PlatformIntegrationStatus;
  lastSyncAt: string | null;
  lastFailureAt: string | null;
  lastFailureSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformIntegrationPage {
  data: PlatformIntegrationSummary[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface PlatformIntegrationReadRepository {
  list(input: PlatformIntegrationListInput): Promise<PlatformIntegrationPage>;
  findById(id: string): Promise<PlatformIntegrationSummary | null>;
}
