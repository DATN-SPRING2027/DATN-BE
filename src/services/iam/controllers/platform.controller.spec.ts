import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PLATFORM_PERMISSION } from '../application/authorization/platform-permission.decorator';
import { PlatformController } from './platform.controller';

describe('PlatformController V1 route contract', () => {
  it('keeps the existing A-04 controller prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PlatformController)).toBe(
      'iam/platform',
    );
  });

  it('exposes only the three unchanged A-04 routes and permissions', () => {
    const prototype = PlatformController.prototype as unknown as Record<
      string,
      unknown
    >;
    const routes = Object.getOwnPropertyNames(prototype)
      .flatMap((name) => {
        if (name === 'constructor') return [];
        const handler = prototype[name];
        if (typeof handler !== 'function') return [];

        const pathMetadata: unknown = Reflect.getMetadata(
          PATH_METADATA,
          handler,
        );
        if (typeof pathMetadata !== 'string') return [];

        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        const permission: unknown = Reflect.getMetadata(
          PLATFORM_PERMISSION,
          handler,
        );

        return [
          {
            method,
            path: pathMetadata,
            permission,
          },
        ];
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    expect(routes).toEqual([
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
        method: RequestMethod.POST,
        path: 'organizations',
        permission: 'organization.create',
      },
    ]);
  });
});
