import { SERVICE_DATABASES } from './database-names';
import { CAPTURE_PERSISTENCE } from '../../services/capture/infrastructure/persistence';
import { CHAT_PERSISTENCE } from '../../services/chat/infrastructure/persistence';
import { HANDOVER_PERSISTENCE } from '../../services/handover/infrastructure/persistence';
import { INGESTION_PERSISTENCE } from '../../services/ingestion/infrastructure/persistence';
import { JIRA_PERSISTENCE } from '../../services/jira/infrastructure/persistence';
import { LIFECYCLE_PERSISTENCE } from '../../services/lifecycle/infrastructure/persistence';
import { NOTIFICATION_PERSISTENCE } from '../../services/notification/infrastructure/persistence';
import { IAM_PERSISTENCE } from '../../services/iam/infrastructure/persistence';
import {
  getOwnedServiceDatabaseName,
  resolveServiceDatabaseName,
} from './service-database';

describe('resolveServiceDatabaseName', () => {
  const definition = {
    serviceName: 'iam' as const,
    databaseName: SERVICE_DATABASES.iam,
    collections: [],
  };

  it('requires a standalone service database configuration', () => {
    expect(() => resolveServiceDatabaseName(definition)).toThrow(
      'SERVICE_DATABASE is required',
    );
    expect(() => resolveServiceDatabaseName(definition, '  ')).toThrow(
      'SERVICE_DATABASE is required',
    );
  });

  it('accepts only the mapped database owned by the standalone service', () => {
    expect(resolveServiceDatabaseName(definition, 'continuum_iam')).toBe(
      'continuum_iam',
    );

    expect(() =>
      resolveServiceDatabaseName(definition, 'continuum_capture'),
    ).toThrow('does not match the owning service database');
  });

  it.each(['continuum_db', 'continuum_task', 'unknown'])(
    'rejects a database outside the active service inventory: %s',
    (databaseName) => {
      expect(() =>
        resolveServiceDatabaseName(definition, databaseName),
      ).toThrow('is not an allowed active service database');
    },
  );

  it('resolves the monolith connection from the owned-service mapping', () => {
    expect(getOwnedServiceDatabaseName(definition)).toBe('continuum_iam');
  });

  it('rejects a persistence definition that conflicts with the owner mapping', () => {
    expect(() =>
      getOwnedServiceDatabaseName({
        ...definition,
        serviceName: 'capture',
        databaseName: 'continuum_iam',
      }),
    ).toThrow('does not match the canonical service database mapping');
  });
});

describe('SERVICE_DATABASES', () => {
  it('contains the accepted active service database inventory exactly once', () => {
    const databases = Object.values(SERVICE_DATABASES);

    expect(SERVICE_DATABASES).toEqual({
      iam: 'continuum_iam',
      capture: 'continuum_capture',
      jira: 'continuum_jira',
      lifecycle: 'continuum_lifecycle',
      chat: 'continuum_chat',
      handover: 'continuum_handover',
      ingestion: 'continuum_ingestion',
      notification: 'continuum_notification',
    });
    expect(new Set(databases).size).toBe(databases.length);
    expect(databases).not.toContain('continuum_db');
    expect(databases).not.toContain('continuum_audit');
  });

  it('maps each active service definition to one distinct allowed database', () => {
    const definitions = [
      IAM_PERSISTENCE,
      CAPTURE_PERSISTENCE,
      JIRA_PERSISTENCE,
      LIFECYCLE_PERSISTENCE,
      CHAT_PERSISTENCE,
      HANDOVER_PERSISTENCE,
      INGESTION_PERSISTENCE,
      NOTIFICATION_PERSISTENCE,
    ];
    const resolvedNames = definitions.map(getOwnedServiceDatabaseName);

    expect(resolvedNames).toEqual(Object.values(SERVICE_DATABASES));
    expect(new Set(resolvedNames).size).toBe(definitions.length);
  });
});
