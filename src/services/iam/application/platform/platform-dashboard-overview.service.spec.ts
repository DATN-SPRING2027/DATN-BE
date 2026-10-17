import { ServiceUnavailableException } from '@nestjs/common';
import { PlatformDashboardOverviewService } from './platform-dashboard-overview.service';

describe('PlatformDashboardOverviewService', () => {
  const summary = {
    organizations: { total: 2 },
    users: { total: 3, active: 3, suspended: 0, pendingInvite: 0 },
    projects: { total: 1, active: 1, archived: 0 },
    memberships: {
      total: 2,
      active: 2,
      suspended: 0,
      pendingInvite: 0,
      removed: 0,
    },
    generatedAt: '2026-10-16T12:00:00.000Z',
  };

  it('combines real aggregate counts, service readiness and safe recent activity', async () => {
    const administration = {
      getDashboardSummary: jest.fn().mockResolvedValue(summary),
    };
    const services = {
      listServices: jest.fn().mockResolvedValue({
        data: [
          {
            id: 'iam',
            status: 'READY',
            lastCheckedAt: '2026-10-16T11:59:58.000Z',
          },
          {
            id: 'jira',
            status: 'DEGRADED',
            lastCheckedAt: '2026-10-16T11:59:59.000Z',
          },
          {
            id: 'capture',
            status: 'UNAVAILABLE',
            lastCheckedAt: '2026-10-16T12:00:00.000Z',
          },
        ],
      }),
    };
    const audit = {
      listEvents: jest.fn().mockResolvedValue({
        data: [
          {
            eventId: 'event-1',
            actorUserId: 'sensitive-actor-id',
            action: 'platform.user.status.changed',
            resourceType: 'USER',
            resourceId: 'sensitive-resource-id',
            occurredAt: '2026-10-16T11:59:00.000Z',
          },
        ],
        pagination: { page: 1, pageSize: 5, totalItems: 1, totalPages: 1 },
      }),
    };
    const service = new PlatformDashboardOverviewService(
      administration as never,
      services as never,
      audit as never,
    );

    const result = await service.getOverview();

    expect(result).toMatchObject({
      ...summary,
      serviceHealth: {
        status: 'DEGRADED',
        total: 3,
        ready: 1,
        degraded: 1,
        unavailable: 1,
        lastCheckedAt: '2026-10-16T12:00:00.000Z',
      },
      recentOperationalActivity: {
        availability: 'AVAILABLE',
        items: [
          {
            action: 'platform.user.status.changed',
            resourceType: 'USER',
            occurredAt: '2026-10-16T11:59:00.000Z',
          },
        ],
      },
    });
    expect(services.listServices).toHaveBeenCalledTimes(1);
    expect(audit.listEvents).toHaveBeenCalledWith({ page: 1, pageSize: 5 });
    expect(JSON.stringify(result)).not.toContain('sensitive-actor-id');
    expect(JSON.stringify(result)).not.toContain('sensitive-resource-id');
  });

  it('reports unknown service health and unavailable activity when their owners fail', async () => {
    const service = new PlatformDashboardOverviewService(
      { getDashboardSummary: jest.fn().mockResolvedValue(summary) } as never,
      {
        listServices: jest.fn().mockRejectedValue(new Error('private-url')),
      } as never,
      {
        listEvents: jest.fn().mockRejectedValue(new Error('raw-audit-error')),
      } as never,
    );

    const result = await service.getOverview();

    expect(result.serviceHealth).toEqual({
      status: 'UNKNOWN',
      total: null,
      ready: null,
      degraded: null,
      unavailable: null,
      lastCheckedAt: null,
    });
    expect(result.recentOperationalActivity).toEqual({
      availability: 'UNAVAILABLE',
      items: [],
    });
    expect(JSON.stringify(result)).not.toContain('private-url');
    expect(JSON.stringify(result)).not.toContain('raw-audit-error');
  });

  it('fails closed when the authoritative aggregate query fails', async () => {
    const service = new PlatformDashboardOverviewService(
      {
        getDashboardSummary: jest.fn().mockRejectedValue(new Error('mongo')),
      } as never,
      { listServices: jest.fn() } as never,
      { listEvents: jest.fn() } as never,
    );

    await expect(service.getOverview()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
