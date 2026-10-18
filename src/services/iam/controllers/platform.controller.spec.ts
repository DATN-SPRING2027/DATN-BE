import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PLATFORM_PERMISSION } from '../application/authorization/platform-permission.decorator';
import { PlatformController } from './platform.controller';

type RouteContractEntry = {
  method: unknown;
  path: string;
  permission: unknown;
};

function normalizeRoutePaths(pathMetadata: unknown): string[] {
  if (typeof pathMetadata === 'string') return [pathMetadata];
  if (Array.isArray(pathMetadata) && pathMetadata.length > 0) {
    const paths: unknown[] = Array.from(pathMetadata);
    if (paths.every((path): path is string => typeof path === 'string')) {
      return paths;
    }
  }

  throw new Error('Route metadata must be a string or non-empty string array');
}

function getListAuditHandler(): object {
  const handler: unknown = Object.getOwnPropertyDescriptor(
    PlatformController.prototype,
    'listAudit',
  )?.value;
  if (typeof handler !== 'function') {
    throw new Error('Expected listAudit to be a route handler');
  }
  return handler;
}

function readPlatformRouteInventory(): RouteContractEntry[] {
  const prototype = PlatformController.prototype as unknown as Record<
    string,
    unknown
  >;

  return Object.getOwnPropertyNames(prototype)
    .flatMap((name) => {
      if (name === 'constructor') return [];
      const handler = prototype[name];
      if (typeof handler !== 'function') return [];
      if (!Reflect.hasMetadata(PATH_METADATA, handler)) return [];

      const paths = normalizeRoutePaths(
        Reflect.getMetadata(PATH_METADATA, handler),
      );
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      const permission: unknown = Reflect.getMetadata(
        PLATFORM_PERMISSION,
        handler,
      );

      return paths.map((path) => ({ method, path, permission }));
    })
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        Number(left.method) - Number(right.method),
    );
}

describe('PlatformController Platform Operations route contract', () => {
  it('keeps the existing A-04 controller prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PlatformController)).toBe(
      'iam/platform',
    );
  });

  it('exposes existing routes plus explicitly permissioned V2 operations routes', () => {
    expect(readPlatformRouteInventory()).toEqual([
      {
        method: RequestMethod.GET,
        path: 'ai/operations',
        permission: 'platform.ai.operations.read',
      },
      {
        method: RequestMethod.GET,
        path: 'audit',
        permission: 'platform.audit.read',
      },
      {
        method: RequestMethod.GET,
        path: 'audit/events',
        permission: 'platform.audit.read',
      },
      {
        method: RequestMethod.GET,
        path: 'audit/events/:eventId',
        permission: 'platform.audit.read',
      },
      {
        method: RequestMethod.GET,
        path: 'audit/resources/:resourceType/:resourceId/history',
        permission: 'platform.audit.read',
      },
      {
        method: RequestMethod.GET,
        path: 'dashboard',
        permission: 'platform.dashboard.summary.read',
      },
      {
        method: RequestMethod.GET,
        path: 'diagnostics/traces/:requestId',
        permission: 'platform.diagnostics.trace.read',
      },
      {
        method: RequestMethod.GET,
        path: 'health',
        permission: 'platform.health.read',
      },
      {
        method: RequestMethod.GET,
        path: 'incidents',
        permission: 'platform.incidents.incident.read',
      },
      {
        method: RequestMethod.POST,
        path: 'incidents',
        permission: 'platform.incidents.incident.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'incidents/:incidentId',
        permission: 'platform.incidents.incident.read',
      },
      {
        method: RequestMethod.POST,
        path: 'incidents/:incidentId/acknowledge',
        permission: 'platform.incidents.incident.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'incidents/:incidentId/history',
        permission: 'platform.incidents.incident.read',
      },
      {
        method: RequestMethod.POST,
        path: 'incidents/:incidentId/notes',
        permission: 'platform.incidents.incident.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'incidents/:incidentId/resolve',
        permission: 'platform.incidents.incident.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'integrations',
        permission: 'platform.integrations.integration.read',
      },
      {
        method: RequestMethod.GET,
        path: 'integrations/:integrationId',
        permission: 'platform.integrations.integration.read',
      },
      {
        method: RequestMethod.POST,
        path: 'integrations/:integrationId/reconnect',
        permission: 'platform.integrations.integration.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'integrations/:integrationId/test',
        permission: 'platform.integrations.integration.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'jobs',
        permission: 'platform.jobs.job.read',
      },
      {
        method: RequestMethod.GET,
        path: 'jobs/:queueId/:jobId',
        permission: 'platform.jobs.job.read',
      },
      {
        method: RequestMethod.POST,
        path: 'jobs/:queueId/:jobId/cancel',
        permission: 'platform.jobs.job.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'jobs/:queueId/:jobId/retry',
        permission: 'platform.jobs.job.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'memberships',
        permission: 'platform.memberships.membership.read',
      },
      {
        method: RequestMethod.GET,
        path: 'memberships/:membershipId',
        permission: 'platform.memberships.membership.read',
      },
      {
        method: RequestMethod.GET,
        path: 'organizations',
        permission: 'platform.organizations.organization.read',
      },
      {
        method: RequestMethod.POST,
        path: 'organizations',
        permission: 'organization.create',
      },
      {
        method: RequestMethod.GET,
        path: 'organizations/:organizationId',
        permission: 'platform.organizations.organization.read',
      },
      {
        method: RequestMethod.PATCH,
        path: 'organizations/:organizationId',
        permission: 'platform.organizations.organization.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'organizations/:organizationId/invitations',
        permission: 'platform.memberships.membership.read',
      },
      {
        method: RequestMethod.POST,
        path: 'organizations/:organizationId/invitations',
        permission: 'platform.memberships.invitation.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'organizations/:organizationId/invitations/:invitationId/cancel',
        permission: 'platform.memberships.invitation.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'organizations/:organizationId/invitations/:invitationId/resend',
        permission: 'platform.memberships.invitation.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'organizations/:organizationId/memberships',
        permission: 'platform.memberships.membership.read',
      },
      {
        method: RequestMethod.POST,
        path: 'organizations/:organizationId/memberships/:membershipId/suspend',
        permission: 'platform.memberships.lifecycle.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'projects',
        permission: 'platform.projects.project.read',
      },
      {
        method: RequestMethod.GET,
        path: 'projects/:projectId',
        permission: 'platform.projects.project.read',
      },
      {
        method: RequestMethod.PATCH,
        path: 'projects/:projectId',
        permission: 'platform.projects.project.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'projects/:projectId/memberships',
        permission: 'platform.projects.project.read',
      },
      {
        method: RequestMethod.GET,
        path: 'queues',
        permission: 'platform.jobs.job.read',
      },
      {
        method: RequestMethod.GET,
        path: 'queues/:queueId',
        permission: 'platform.jobs.job.read',
      },
      {
        method: RequestMethod.GET,
        path: 'services',
        permission: 'platform.services.service.read',
      },
      {
        method: RequestMethod.GET,
        path: 'services/:serviceId',
        permission: 'platform.services.service.read',
      },
      {
        method: RequestMethod.GET,
        path: 'users',
        permission: 'platform.users.account.read',
      },
      {
        method: RequestMethod.GET,
        path: 'users/:userId',
        permission: 'platform.users.account.read',
      },
      {
        method: RequestMethod.PATCH,
        path: 'users/:userId',
        permission: 'platform.users.account.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'users/:userId/archive',
        permission: 'platform.users.account.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'users/:userId/restore',
        permission: 'platform.users.account.manage',
      },
      {
        method: RequestMethod.GET,
        path: 'users/:userId/organizations',
        permission: 'platform.users.account.read',
      },
      {
        method: RequestMethod.GET,
        path: 'users/:userId/sessions',
        permission: 'platform.sessions.session.read',
      },
      {
        method: RequestMethod.GET,
        path: 'users/:userId/sessions/:sessionId',
        permission: 'platform.sessions.session.read',
      },
      {
        method: RequestMethod.POST,
        path: 'users/:userId/sessions/:sessionId/revoke',
        permission: 'platform.sessions.session.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'users/:userId/sessions/revoke-all',
        permission: 'platform.sessions.session.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'users/:userId/sessions/revoke-bulk',
        permission: 'platform.sessions.session.manage',
      },
      {
        method: RequestMethod.PATCH,
        path: 'users/:userId/status',
        permission: 'platform.users.account.manage',
      },
      {
        method: RequestMethod.POST,
        path: 'users/lookup',
        permission: 'platform.users.account.read',
      },
    ]);
  });

  it('includes every path when a route handler declares aliases', () => {
    const handler = getListAuditHandler();
    const originalPaths: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    Reflect.defineMetadata(PATH_METADATA, ['audit', 'audit-alias'], handler);

    try {
      expect(readPlatformRouteInventory()).toContainEqual({
        method: RequestMethod.GET,
        path: 'audit-alias',
        permission: 'platform.audit.read',
      });
    } finally {
      Reflect.defineMetadata(PATH_METADATA, originalPaths, handler);
    }
  });

  it('fails instead of skipping a handler with malformed route metadata', () => {
    const handler = getListAuditHandler();
    const originalPaths: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    Reflect.defineMetadata(PATH_METADATA, ['audit', 42], handler);

    try {
      expect(readPlatformRouteInventory).toThrow(
        'Route metadata must be a string or non-empty string array',
      );
    } finally {
      Reflect.defineMetadata(PATH_METADATA, originalPaths, handler);
    }
  });
});
