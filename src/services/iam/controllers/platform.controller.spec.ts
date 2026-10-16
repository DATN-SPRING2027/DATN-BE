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

describe('PlatformController V1 route contract', () => {
  it('keeps the existing A-04 controller prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PlatformController)).toBe(
      'iam/platform',
    );
  });

  it('exposes only the eight approved administration/platform routes and exact permissions', () => {
    expect(readPlatformRouteInventory()).toEqual([
      {
        method: RequestMethod.GET,
        path: 'audit',
        permission: 'platform.audit.read',
      },
      {
        method: RequestMethod.GET,
        path: 'health',
        permission: 'platform.health.read',
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
