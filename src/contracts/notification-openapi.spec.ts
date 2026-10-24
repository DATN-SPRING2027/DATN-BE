import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NOTIFICATION_MVP_TYPES,
  NOTIFICATION_TARGET_KINDS,
} from '../services/notification/infrastructure/mongodb/mongodb.schemas';

describe('Notification Center v1 OpenAPI contract alignment', () => {
  const document = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'docs/openapi/notification-v1.openapi.json'),
      'utf8',
    ),
  ) as {
    openapi: string;
    paths: Record<string, Record<string, unknown>>;
    components: {
      schemas: {
        NotificationMvpType: { enum: string[] };
        NotificationTargetKind: { enum: string[] };
      };
    };
  };

  it('declares all 5 Notification Center endpoints and matches schema enums', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/api/v1/notifications',
        '/api/v1/notifications/unread-count',
        '/api/v1/notifications/{id}/read',
        '/api/v1/notifications/read-all',
        '/api/v1/notifications/{id}/resolve',
      ].sort(),
    );
    expect(document.components.schemas.NotificationMvpType.enum).toEqual([
      ...NOTIFICATION_MVP_TYPES,
    ]);
    expect(document.components.schemas.NotificationTargetKind.enum).toEqual([
      ...NOTIFICATION_TARGET_KINDS,
    ]);
  });
});
