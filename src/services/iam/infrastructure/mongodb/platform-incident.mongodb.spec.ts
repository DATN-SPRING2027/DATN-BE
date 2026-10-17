import { randomUUID } from 'node:crypto';
/* eslint-disable @typescript-eslint/no-unsafe-return -- Mongoose query doubles expose driver any types. */
import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import { IAM_AUDIT_COLLECTION_NAME } from '../../../../common/mongodb/database-names';
import type { PlatformIncidentCommandInput } from '../../application/platform/platform-incident.repository';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoPlatformIncidentRepository } from './platform-incident.repository';

describe('MongoPlatformIncidentRepository transactional integration', () => {
  jest.setTimeout(120_000);

  let replicaSet: MongoMemoryReplSet;
  let connection: Connection;
  let repository: MongoPlatformIncidentRepository;
  const databaseName = `platform_incident_${randomUUID().replaceAll('-', '')}`;
  const auditDatabaseName = `${databaseName}_audit`;
  const actorId = new Types.ObjectId();
  const issuerId = new Types.ObjectId();
  const permission = 'platform.incidents.incident.manage';
  const now = new Date('2026-10-17T09:00:00.000Z');
  const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;
  const audit = () =>
    connection
      .useDb(auditDatabaseName, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME);

  const input = (
    command: PlatformIncidentCommandInput['command'],
    key = `incident-operation-${randomUUID()}`,
  ): PlatformIncidentCommandInput => ({
    actorUserId: actorId.toHexString(),
    idempotencyKey: key,
    command,
    now,
    correlationId: 'trace-incident-integration-1',
  });

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: {
        count: 1,
        name: 'test-rs-platform-incidents',
        storageEngine: 'wiredTiger',
      },
    });
    connection = mongoose.createConnection(replicaSet.getUri(), {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    });
    await connection.asPromise();

    for (const name of [
      'users',
      'platform_authority_assignments',
      'platform_authority_change_locks',
      'platform_incidents',
      'platform_incident_history',
      'platform_incident_operations',
    ]) {
      await connection.createCollection(name);
      const definition = IAM_PERSISTENCE.collections.find(
        (collection) => collection.name === name,
      );
      if (definition) {
        await connection
          .model(modelName(name), createCollectionSchema(definition))
          .createIndexes();
      }
    }
    await connection.collection('platform_incidents').createIndexes([
      { key: { updatedAt: -1, _id: -1 }, name: 'incident_updated_list' },
      {
        key: { status: 1, updatedAt: -1, _id: -1 },
        name: 'incident_status_updated_list',
      },
    ]);
    await connection
      .collection('platform_incident_history')
      .createIndex(
        { incidentId: 1, occurredAt: 1, _id: 1 },
        { name: 'incident_history_order' },
      );
    await connection.collection('platform_incident_operations').createIndexes([
      {
        key: { actorUserId: 1, idempotencyKeyHash: 1 },
        name: 'incident_operation_key',
        unique: true,
      },
      {
        key: { incidentId: 1, committedAt: -1 },
        name: 'incident_operation_history',
      },
    ]);
    const auditDatabase = connection.useDb(auditDatabaseName, {
      useCache: true,
    });
    await auditDatabase.createCollection(IAM_AUDIT_COLLECTION_NAME);
    repository = new MongoPlatformIncidentRepository(
      connection,
      auditDatabaseName,
    );
  });

  afterAll(async () => {
    await connection?.close();
    await replicaSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [
      'users',
      'platform_authority_assignments',
      'platform_incidents',
      'platform_incident_history',
      'platform_incident_operations',
    ])
      await connection.collection(name).deleteMany({});
    await audit().deleteMany({});
    await connection
      .collection('platform_authority_change_locks')
      .deleteMany({});
    await connection.collection('users').insertOne({
      _id: actorId,
      email: 'platform-incident-operator@example.test',
      fullName: 'Platform Incident Operator',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    await connection.collection('platform_authority_assignments').insertOne({
      _id: new Types.ObjectId(),
      subjectUserId: actorId,
      permission,
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date(now.getTime() - 1_000),
      grantedBy: issuerId,
      expiresAt: null,
      revokedAt: null,
    });
    await connection.collection('platform_authority_change_locks').insertOne({
      permission: 'PLATFORM_OPERATOR_LIFECYCLE',
      scope: 'PLATFORM',
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  it('commits incident, initial history, audit, and exact replay together', async () => {
    const command = {
      command: 'CREATE' as const,
      title: 'Ingestion service unavailable',
      severity: 'HIGH' as const,
      affectedServiceId: 'ingestion',
    };
    const first = await repository.execute(
      input(command, 'incident-create-key-001'),
    );
    const replay = await repository.execute(
      input(command, 'incident-create-key-001'),
    );

    expect(first).toMatchObject({ httpStatus: 201, replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      await connection.collection('platform_incidents').countDocuments(),
    ).toBe(1);
    expect(
      await connection.collection('platform_incident_history').countDocuments(),
    ).toBe(1);
    expect(await audit().countDocuments()).toBe(1);
    expect(
      await connection
        .collection('platform_incident_operations')
        .countDocuments(),
    ).toBe(1);
    await expect(
      repository.execute(
        input(
          { ...command, title: 'Different payload' },
          'incident-create-key-001',
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('enforces the transition sequence and records redacted history and safe audit', async () => {
    const created = await repository.execute(
      input({
        command: 'CREATE',
        title: 'Ingestion service unavailable',
        severity: 'HIGH',
        affectedServiceId: 'ingestion',
      }),
    );
    const id = created.body.id;
    await expect(
      repository.execute(
        input({
          command: 'RESOLVE',
          incidentId: id,
          expectedVersion: 1,
          note: 'Premature resolution',
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_INCIDENT_INVALID_TRANSITION' },
    });
    await expect(
      repository.execute(
        input({
          command: 'ACKNOWLEDGE',
          incidentId: id,
          expectedVersion: 8,
          note: 'Stale acknowledgement',
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_INCIDENT_VERSION_CONFLICT' },
    });

    await repository.execute(
      input({
        command: 'ACKNOWLEDGE',
        incidentId: id,
        expectedVersion: 1,
        note: 'Investigating bearer eyJhbGci.abc.def; api_key=sk-test-secret-123',
      }),
    );
    await repository.execute(
      input({
        command: 'RESOLVE',
        incidentId: id,
        expectedVersion: 2,
        note: 'Service recovered',
      }),
    );
    const history = await repository.listHistory({
      incidentId: id,
      page: 1,
      pageSize: 20,
    });
    expect(history.data.map((item) => item.action)).toEqual([
      'CREATED',
      'ACKNOWLEDGED',
      'RESOLVED',
    ]);
    expect(JSON.stringify(history)).not.toMatch(/eyJhbGci|sk-test-secret/);
    const events = await audit().find({}).toArray();
    expect(events.map((event) => event.action)).toEqual([
      'platform.incident.created',
      'platform.incident.acknowledged',
      'platform.incident.resolved',
    ]);
    expect(events.every((event) => event.targetResource === 'INCIDENT')).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toMatch(/eyJhbGci|sk-test-secret/);
    await expect(
      repository.execute(
        input({
          command: 'ACKNOWLEDGE',
          incidentId: id,
          expectedVersion: 3,
          note: 'Cannot reopen a resolved incident',
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_INCIDENT_INVALID_TRANSITION' },
    });
  });

  it('denies a revoked permission and creates no records', async () => {
    await connection
      .collection('platform_authority_assignments')
      .updateOne(
        { subjectUserId: actorId, permission },
        { $set: { status: 'REVOKED', revokedAt: now } },
      );

    await expect(
      repository.execute(
        input({
          command: 'CREATE',
          title: 'Denied incident',
          severity: 'LOW',
          affectedServiceId: 'iam',
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      await connection.collection('platform_incidents').countDocuments(),
    ).toBe(0);
    expect(
      await connection.collection('platform_incident_history').countDocuments(),
    ).toBe(0);
    expect(
      await connection
        .collection('platform_incident_operations')
        .countDocuments(),
    ).toBe(0);
    expect(await audit().countDocuments()).toBe(0);
  });

  it('rolls back incident state when required audit persistence fails', async () => {
    await audit().drop();
    await connection
      .useDb(auditDatabaseName, { useCache: true })
      .createCollection(IAM_AUDIT_COLLECTION_NAME, {
        validator: {
          $jsonSchema: { bsonType: 'object', required: ['blocked'] },
        },
      });
    await expect(
      repository.execute(
        input({
          command: 'CREATE',
          title: 'Audit rollback incident',
          severity: 'MEDIUM',
          affectedServiceId: 'iam',
        }),
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(
      await connection.collection('platform_incidents').countDocuments(),
    ).toBe(0);
    expect(
      await connection.collection('platform_incident_history').countDocuments(),
    ).toBe(0);
    expect(
      await connection
        .collection('platform_incident_operations')
        .countDocuments(),
    ).toBe(0);

    await audit().drop();
    await connection
      .useDb(auditDatabaseName, { useCache: true })
      .createCollection(IAM_AUDIT_COLLECTION_NAME);
  });

  it('serializes concurrent exact commands to one commit and one replay', async () => {
    const command = {
      command: 'CREATE' as const,
      title: 'Concurrent incident request',
      severity: 'MEDIUM' as const,
      affectedServiceId: 'iam',
    };
    const results = await Promise.all([
      repository.execute(input(command, 'incident-concurrent-key-001')),
      repository.execute(input(command, 'incident-concurrent-key-001')),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(results[0].body.id).toBe(results[1].body.id);
    expect(
      await connection.collection('platform_incidents').countDocuments(),
    ).toBe(1);
    expect(
      await connection.collection('platform_incident_history').countDocuments(),
    ).toBe(1);
    expect(
      await connection
        .collection('platform_incident_operations')
        .countDocuments(),
    ).toBe(1);
    expect(await audit().countDocuments()).toBe(1);
  });
});
