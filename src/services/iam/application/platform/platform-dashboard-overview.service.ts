import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  PlatformAuditAction,
  PlatformAuditResourceType,
} from './platform-audit.repository';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAdministrationService } from './platform-administration.service';
import type { PlatformDashboardSummary } from './platform-administration.repository';
import { PlatformServiceOperationsService } from './platform-service-operations.service';

export interface PlatformDashboardServiceHealth {
  status: 'READY' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';
  total: number | null;
  ready: number | null;
  degraded: number | null;
  unavailable: number | null;
  lastCheckedAt: string | null;
}

export interface PlatformDashboardRecentActivity {
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  items: Array<{
    action: PlatformAuditAction;
    resourceType: PlatformAuditResourceType;
    occurredAt: string;
  }>;
}

export interface PlatformDashboardOverview extends PlatformDashboardSummary {
  serviceHealth: PlatformDashboardServiceHealth;
  recentOperationalActivity: PlatformDashboardRecentActivity;
}

const unknownServiceHealth: PlatformDashboardServiceHealth = {
  status: 'UNKNOWN',
  total: null,
  ready: null,
  degraded: null,
  unavailable: null,
  lastCheckedAt: null,
};

function settle<T>(
  request: () => Promise<T>,
): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected' }> {
  return Promise.resolve()
    .then(request)
    .then((value) => ({ status: 'fulfilled' as const, value }))
    .catch(() => ({ status: 'rejected' as const }));
}

@Injectable()
export class PlatformDashboardOverviewService {
  constructor(
    private readonly administration: PlatformAdministrationService,
    private readonly services: PlatformServiceOperationsService,
    private readonly audit: PlatformAuditService,
  ) {}

  async getOverview(): Promise<PlatformDashboardOverview> {
    const [summaryResult, servicesResult, activityResult] = await Promise.all([
      settle(() => this.administration.getDashboardSummary()),
      settle(() => this.services.listServices()),
      settle(() => this.audit.listEvents({ page: 1, pageSize: 5 })),
    ]);

    if (summaryResult.status !== 'fulfilled')
      throw new ServiceUnavailableException({
        code: 'IAM_PLATFORM_DASHBOARD_UNAVAILABLE',
      });

    return {
      ...summaryResult.value,
      serviceHealth:
        servicesResult.status === 'fulfilled'
          ? this.summarizeServices(servicesResult.value.data)
          : unknownServiceHealth,
      recentOperationalActivity:
        activityResult.status === 'fulfilled' &&
        Array.isArray(activityResult.value.data)
          ? {
              availability: 'AVAILABLE',
              items: activityResult.value.data.slice(0, 5).map((event) => ({
                action: event.action,
                resourceType: event.resourceType,
                occurredAt: event.occurredAt,
              })),
            }
          : { availability: 'UNAVAILABLE', items: [] },
    };
  }

  private summarizeServices(
    data: Awaited<
      ReturnType<PlatformServiceOperationsService['listServices']>
    >['data'],
  ): PlatformDashboardServiceHealth {
    if (!Array.isArray(data) || data.length === 0) return unknownServiceHealth;
    const ready = data.filter((service) => service.status === 'READY').length;
    const degraded = data.filter(
      (service) => service.status === 'DEGRADED',
    ).length;
    const unavailable = data.filter(
      (service) => service.status === 'UNAVAILABLE',
    ).length;
    const checked = data
      .map((service) => service.lastCheckedAt)
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left));
    const status =
      unavailable === data.length
        ? 'UNAVAILABLE'
        : unavailable > 0 || degraded > 0
          ? 'DEGRADED'
          : ready === data.length
            ? 'READY'
            : 'UNKNOWN';
    return {
      status,
      total: data.length,
      ready,
      degraded,
      unavailable,
      lastCheckedAt: checked[0] ?? null,
    };
  }
}
