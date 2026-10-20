import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PlatformController } from '../services/iam/controllers/platform.controller';
import { GatewayIamController } from './gateway-iam.controller';

type Route = { method: RequestMethod; path: string };

function paths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((path) => typeof path === 'string')
  )
    return value;
  throw new Error('Route metadata must contain one or more paths');
}

function routes(controller: { prototype: object }, prefix = ''): Route[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((name) => {
    if (name === 'constructor') return [];
    const handler = prototype[name];
    if (
      typeof handler !== 'function' ||
      !Reflect.hasMetadata(PATH_METADATA, handler)
    )
      return [];
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      handler,
    ) as RequestMethod;
    return paths(Reflect.getMetadata(PATH_METADATA, handler)).map((path) => ({
      method,
      path: [prefix, path].filter(Boolean).join('/'),
    }));
  });
}

describe('Gateway Platform route forwarding', () => {
  it('forwards every Platform IAM handler through the public gateway', () => {
    const iamPlatformRoutes = routes(
      PlatformController,
      String(Reflect.getMetadata(PATH_METADATA, PlatformController)),
    );
    const gatewayRoutes = routes(GatewayIamController);
    const forwarded = new Set(
      gatewayRoutes.map(({ method, path }) => `${method}:${path}`),
    );

    expect(iamPlatformRoutes.length).toBeGreaterThan(0);
    for (const route of iamPlatformRoutes) {
      expect(forwarded).toContain(`${route.method}:${route.path}`);
    }
  });

  it('keeps the Gateway route contract aligned with required Platform reads', () => {
    const gatewayRoutes = new Set(
      routes(GatewayIamController).map(
        ({ method, path }) => `${method}:${path}`,
      ),
    );
    for (const [method, path] of [
      [RequestMethod.GET, 'iam/platform/memberships'],
      [RequestMethod.GET, 'iam/platform/memberships/:membershipId'],
      [
        RequestMethod.POST,
        'iam/organizations/:organizationId/memberships/:membershipId/role',
      ],
      [
        RequestMethod.GET,
        'iam/platform/organizations/:organizationId/memberships',
      ],
      [
        RequestMethod.POST,
        'iam/platform/organizations/:organizationId/memberships/:membershipId/suspend',
      ],
      [
        RequestMethod.POST,
        'iam/platform/organizations/:organizationId/invitations',
      ],
      [
        RequestMethod.POST,
        'iam/platform/organizations/:organizationId/invitations/:invitationId/resend',
      ],
      [
        RequestMethod.POST,
        'iam/platform/organizations/:organizationId/invitations/:invitationId/cancel',
      ],
      [RequestMethod.GET, 'iam/platform/users'],
      [RequestMethod.GET, 'iam/platform/users/:userId'],
      [RequestMethod.PATCH, 'iam/platform/users/:userId'],
      [RequestMethod.PATCH, 'iam/platform/users/:userId/status'],
      [RequestMethod.POST, 'iam/platform/users/:userId/archive'],
      [RequestMethod.POST, 'iam/platform/users/:userId/restore'],
      [RequestMethod.POST, 'iam/platform/users/lookup'],
      [RequestMethod.GET, 'iam/platform/diagnostics/traces/:requestId'],
      [RequestMethod.GET, 'iam/platform/incidents'],
      [RequestMethod.GET, 'iam/platform/incidents/:incidentId'],
      [RequestMethod.GET, 'iam/platform/incidents/:incidentId/history'],
      [RequestMethod.POST, 'iam/platform/incidents'],
      [RequestMethod.POST, 'iam/platform/incidents/:incidentId/acknowledge'],
      [RequestMethod.POST, 'iam/platform/incidents/:incidentId/resolve'],
      [RequestMethod.POST, 'iam/platform/incidents/:incidentId/notes'],
      [RequestMethod.POST, 'iam/platform/jobs/:queueId/:jobId/retry'],
      [RequestMethod.POST, 'iam/platform/jobs/:queueId/:jobId/cancel'],
      [RequestMethod.POST, 'iam/platform/integrations/:integrationId/test'],
      [
        RequestMethod.POST,
        'iam/platform/integrations/:integrationId/reconnect',
      ],
    ] as const) {
      expect(gatewayRoutes).toContain(`${method}:${path}`);
    }
  });
});
