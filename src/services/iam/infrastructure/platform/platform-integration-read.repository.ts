import { createHmac } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PlatformIntegrationListInput,
  PlatformIntegrationPage,
  PlatformIntegrationReadRepository,
  PlatformIntegrationStatus,
  PlatformIntegrationSummary,
} from '../../application/platform/platform-integration-read.repository';

const requestTimeoutMs = 3_000;
const objectIdPattern = /^[a-f\d]{24}$/i;
const statuses: readonly PlatformIntegrationStatus[] = [
  'CONNECTED',
  'EXPIRED',
  'REVOKED',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseSummary(value: unknown): PlatformIntegrationSummary | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    !objectIdPattern.test(value.id) ||
    value.provider !== 'JIRA' ||
    typeof value.organizationId !== 'string' ||
    !objectIdPattern.test(value.organizationId) ||
    typeof value.projectId !== 'string' ||
    !objectIdPattern.test(value.projectId) ||
    typeof value.status !== 'string' ||
    !statuses.includes(value.status as PlatformIntegrationStatus) ||
    (value.lastSyncAt !== null && !validTimestamp(value.lastSyncAt)) ||
    (value.lastFailureAt !== null && !validTimestamp(value.lastFailureAt)) ||
    (value.lastFailureSummary !== null &&
      typeof value.lastFailureSummary !== 'string') ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    provider: 'JIRA',
    organizationId: value.organizationId,
    projectId: value.projectId,
    status: value.status as PlatformIntegrationStatus,
    lastSyncAt: value.lastSyncAt,
    lastFailureAt: value.lastFailureAt,
    lastFailureSummary: value.lastFailureSummary,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parsePage(value: unknown): PlatformIntegrationPage | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    !isRecord(value.pagination)
  ) {
    return null;
  }
  const rows = value.data.map(parseSummary);
  const pagination = value.pagination;
  if (
    rows.some((row) => row === null) ||
    !Number.isSafeInteger(pagination.page) ||
    !Number.isSafeInteger(pagination.pageSize) ||
    !Number.isSafeInteger(pagination.totalItems) ||
    !Number.isSafeInteger(pagination.totalPages)
  ) {
    return null;
  }
  return {
    data: rows as PlatformIntegrationSummary[],
    pagination: {
      page: pagination.page as number,
      pageSize: pagination.pageSize as number,
      totalItems: pagination.totalItems as number,
      totalPages: pagination.totalPages as number,
    },
  };
}

@Injectable()
export class PlatformIntegrationReadHttpRepository implements PlatformIntegrationReadRepository {
  constructor(private readonly config: ConfigService) {}

  async list(
    input: PlatformIntegrationListInput,
  ): Promise<PlatformIntegrationPage> {
    const url = this.createUrl(input);
    const payload = await this.request(url);
    const page = parsePage(payload);
    if (!page) this.unavailable();
    return page;
  }

  async findById(id: string): Promise<PlatformIntegrationSummary | null> {
    const url = this.createUrl();
    url.pathname = `${url.pathname}/${encodeURIComponent(id)}`;
    const response = await this.fetchOwner(url);
    if (response.status === 404) return null;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.unavailable();
    }
    if (!response.ok) this.unavailable();
    const summary = parseSummary(payload);
    if (!summary) this.unavailable();
    return summary;
  }

  private async request(url: URL): Promise<unknown> {
    const response = await this.fetchOwner(url);
    if (!response.ok) this.unavailable();
    try {
      return await response.json();
    } catch {
      this.unavailable();
    }
  }

  private createUrl(input?: PlatformIntegrationListInput): URL {
    const baseUrl = this.config.get<string>('JIRA_SERVICE_URL');
    if (!baseUrl) this.unavailable();
    let url: URL;
    try {
      url = new URL('/internal/platform/integrations', baseUrl);
    } catch {
      return this.unavailable();
    }
    if (input) {
      url.searchParams.set('page', String(input.page));
      url.searchParams.set('pageSize', String(input.pageSize));
      if (input.organizationId)
        url.searchParams.set('organizationId', input.organizationId);
      if (input.projectId) url.searchParams.set('projectId', input.projectId);
      if (input.status) url.searchParams.set('status', input.status);
    }
    return url;
  }

  private async fetchOwner(url: URL): Promise<globalThis.Response> {
    const secret = this.config.get<string>('PLATFORM_SERVICE_OPS_SECRET');
    if (!secret || secret.length < 32) return this.unavailable();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const canonical = `${timestamp}\nGET\n${url.pathname}${url.search}`;
    const signature = createHmac('sha256', secret)
      .update(canonical)
      .digest('hex');
    try {
      return await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-platform-ops-timestamp': timestamp,
          'x-platform-ops-signature': signature,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return this.unavailable();
    }
  }

  private unavailable(): never {
    throw new ServiceUnavailableException(
      'Platform integration owner unavailable',
    );
  }
}
