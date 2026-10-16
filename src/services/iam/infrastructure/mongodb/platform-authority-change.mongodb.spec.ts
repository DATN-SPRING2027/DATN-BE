import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import { MongoPlatformAuthorityChangeRepository } from './platform-authority-change.repository';
import { MongoPlatformAuditRepository } from './platform-audit.repository';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import type { PlatformAuthorityChangeCommand } from '../../application/platform/platform-authority-change.types';

describe('Platform authority change operations transactional integration', () => {
  jest.setTimeout(120_000);

  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let repository: MongoPlatformAuthorityChangeRepository;
  let auditRepository: MongoPlatformAuditRepository;

  const databaseName = `test_iam_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const auditDatabaseName = `${databaseName}_audit`;

  let executorId: Types.ObjectId;
  let issuerId: Types.ObjectId;
  let targetUserId1: Types.ObjectId;
  let targetUserId2: Types.ObjectId;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: {
        count: 1,
        name: 'test-rs-platform-authority',
        storageEngine: 'wiredTiger',
      },
    });

    connection = mongoose.createConnection(replSet.getUri(), {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    });
    await connection.asPromise();

    const db = connection.db;
    if (!db) throw new Error('Database connection not established');

    // Create declared IAM collections and indexes
    const collections = [
      'users',
      'platform_authority_assignments',
      'platform_authority_change_operations',
    ];
    for (const name of collections) {
      await db.createCollection(name);
      const def = IAM_PERSISTENCE.collections.find((c) => c.name === name);
      if (def) {
        await connection
          .model(`continuum_iam_${name}`, createCollectionSchema(def))
          .createIndexes();
      }
    }

    // Create Audit collection
    const auditDb = connection.useDb(auditDatabaseName, { useCache: true });
    await auditDb.createCollection('audit_logs_iam');

    repository = new MongoPlatformAuthorityChangeRepository(
      connection,
      auditDatabaseName,
    );
    auditRepository = new MongoPlatformAuditRepository(
      connection,
      auditDatabaseName,
    );
  });

  afterAll(async () => {
    await connection?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    const db = connection.db!;
    await db.collection('users').deleteMany({});
    await db.collection('platform_authority_assignments').deleteMany({});
    await db.collection('platform_authority_change_operations').deleteMany({});
    await connection
      .useDb(auditDatabaseName, { useCache: true })
      .collection('audit_logs_iam')
      .deleteMany({});

    executorId = new Types.ObjectId();
    issuerId = new Types.ObjectId();
    targetUserId1 = new Types.ObjectId();
    targetUserId2 = new Types.ObjectId();

    await db.collection('users').insertMany([
      {
        _id: executorId,
        email: 'executor@continuum.test',
        status: 'ACTIVE',
        twoFactorEnabled: true,
      },
      {
        _id: issuerId,
        email: 'issuer@continuum.test',
        status: 'ACTIVE',
        twoFactorEnabled: true,
      },
      {
        _id: targetUserId1,
        email: 'target1@continuum.test',
        status: 'ACTIVE',
        twoFactorEnabled: true,
      },
      {
        _id: targetUserId2,
        email: 'target2@continuum.test',
        status: 'ACTIVE',
        twoFactorEnabled: true,
      },
    ]);
  });

  it('atomically commits assignment, ledger, and audit on valid GRANT', async () => {
    const command: PlatformAuthorityChangeCommand = {
      operationId: 'op-grant-test-01',
      operationType: 'GRANT',
      targetUserId: targetUserId1.toHexString(),
      permission: 'organization.create',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'PO_AUTH_01_PROVISIONING',
      mfaVerified: true,
    };

    const result = await repository.execute(command);
    expect(result.status).toBe('COMMITTED');
    expect(result.httpStatus).toBe(201);
    expect(result.replayed).toBe(false);
    expect(result.body.permission).toBe('organization.create');
    expect(result.body.status).toBe('ACTIVE');

    const db = connection.db!;
    const assignment = await db
      .collection('platform_authority_assignments')
      .findOne({ subjectUserId: targetUserId1 });
    expect(assignment).toBeDefined();
    expect(assignment?.status).toBe('ACTIVE');
    expect(assignment?.permission).toBe('organization.create');
    expect(String(assignment?.grantedBy)).toBe(issuerId.toHexString());

    const ledger = await db
      .collection('platform_authority_change_operations')
      .findOne({ operationId: 'op-grant-test-01' });
    expect(ledger).toBeDefined();
    expect(ledger?.status).toBe('COMMITTED');
    expect(String(ledger?.actorUserId)).toBe(executorId.toHexString());
    expect(String(ledger?.issuerUserId)).toBe(issuerId.toHexString());

    const auditDb = connection.useDb(auditDatabaseName, { useCache: true });
    const auditLogs = await auditDb
      .collection('audit_logs_iam')
      .find({ operationId: 'op-grant-test-01' })
      .toArray();
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('platform.authority.granted');
    expect(auditLogs[0].targetResource).toBe('PLATFORM_AUTHORITY');
    expect(auditLogs[0].actorUserId).toBe(executorId.toHexString());

    // Verify MongoPlatformAuditRepository reads this operational audit event
    const auditRecords = await auditRepository.listOperationalMetadata();
    expect(auditRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'platform.authority.granted',
          targetResource: 'PLATFORM_AUTHORITY',
          targetResourceId: assignment?._id.toHexString(),
          actorUserId: executorId.toHexString(),
        }),
      ]),
    );
  });

  it('idempotently replays previous result when called with same operationId and same payload', async () => {
    const command: PlatformAuthorityChangeCommand = {
      operationId: 'op-replay-01',
      operationType: 'GRANT',
      targetUserId: targetUserId1.toHexString(),
      permission: 'organization.create',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'REPLAY_TEST',
      mfaVerified: true,
    };

    const first = await repository.execute(command);
    expect(first.replayed).toBe(false);

    const second = await repository.execute(command);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);

    const db = connection.db!;
    expect(
      await db
        .collection('platform_authority_change_operations')
        .countDocuments({ operationId: 'op-replay-01' }),
    ).toBe(1);
  });

  it('throws 409 Conflict when duplicate operationId is sent with different payload', async () => {
    const command: PlatformAuthorityChangeCommand = {
      operationId: 'op-conflict-01',
      operationType: 'GRANT',
      targetUserId: targetUserId1.toHexString(),
      permission: 'organization.create',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'FIRST_ATTEMPT',
      mfaVerified: true,
    };
    await repository.execute(command);

    await expect(
      repository.execute({
        ...command,
        reasonCode: 'DIFFERENT_REASON_AND_PAYLOAD',
      }),
    ).rejects.toMatchObject({
      response: { code: 'OPERATION_PAYLOAD_MISMATCH' },
    });
  });

  it('enforces CAS: rejects GRANT if expectedCurrentStatus is mismatched', async () => {
    await repository.execute({
      operationId: 'op-cas-initial',
      operationType: 'GRANT',
      targetUserId: targetUserId1.toHexString(),
      permission: 'platform.health.read',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'INITIAL_GRANT',
      mfaVerified: true,
    });

    await expect(
      repository.execute({
        operationId: 'op-cas-fail',
        operationType: 'GRANT',
        targetUserId: targetUserId1.toHexString(),
        permission: 'platform.health.read',
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        expectedCurrentStatus: 'REVOKED', // Target is ACTIVE, but expected REVOKED
        reasonCode: 'MISMATCH_TEST',
        mfaVerified: true,
      }),
    ).rejects.toMatchObject({
      response: { code: 'CAS_STATUS_MISMATCH' },
    });
  });

  it('blocks duplicate active grant when target already holds active authority (preserving legacy row)', async () => {
    await repository.execute({
      operationId: 'op-first-grant',
      operationType: 'GRANT',
      targetUserId: targetUserId1.toHexString(),
      permission: 'platform.audit.read',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'INITIAL_GRANT',
      mfaVerified: true,
    });

    await expect(
      repository.execute({
        operationId: 'op-second-grant-diff-id',
        operationType: 'GRANT',
        targetUserId: targetUserId1.toHexString(),
        permission: 'platform.audit.read',
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'DUPLICATE_ATTEMPT',
        mfaVerified: true,
      }),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_AUTHORITY_ALREADY_ACTIVE' },
    });
  });

  it('enforces last-operator protection: blocks revoking the sole active operator without break-glass', async () => {
    await repository.execute({
      operationId: 'op-grant-sole-operator',
      operationType: 'GRANT',
      targetUserId: targetUserId1.toHexString(),
      permission: 'organization.create',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'SOLE_OPERATOR_SETUP',
      mfaVerified: true,
    });

    // Attempting to revoke the only operator without breakGlass
    await expect(
      repository.execute({
        operationId: 'op-revoke-sole-blocked',
        operationType: 'REVOKE',
        targetUserId: targetUserId1.toHexString(),
        permission: 'organization.create',
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'TRYING_REVOKE_LAST',
        mfaVerified: true,
        breakGlass: false,
      }),
    ).rejects.toMatchObject({
      response: { code: 'LAST_OPERATOR_REVOCATION_BLOCKED' },
    });

    // Revoking with explicit breakGlass succeeds
    const breakGlassResult = await repository.execute({
      operationId: 'op-revoke-sole-breakglass',
      operationType: 'REVOKE',
      targetUserId: targetUserId1.toHexString(),
      permission: 'organization.create',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'EMERGENCY_DECOMMISSION_AUTHORIZED',
      mfaVerified: true,
      breakGlass: true,
    });
    expect(breakGlassResult.status).toBe('COMMITTED');
    expect(breakGlassResult.body.status).toBe('REVOKED');
  });

  it('allows revocation when multiple active operators exist', async () => {
    await repository.execute({
      operationId: 'op-grant-op1',
      operationType: 'GRANT',
      targetUserId: targetUserId1.toHexString(),
      permission: 'platform.health.read',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'OP1_SETUP',
      mfaVerified: true,
    });

    await repository.execute({
      operationId: 'op-grant-op2',
      operationType: 'GRANT',
      targetUserId: targetUserId2.toHexString(),
      permission: 'platform.health.read',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'OP2_SETUP',
      mfaVerified: true,
    });

    const revokeResult = await repository.execute({
      operationId: 'op-revoke-op1',
      operationType: 'REVOKE',
      targetUserId: targetUserId1.toHexString(),
      permission: 'platform.health.read',
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'OP1_DEPARTURE',
      mfaVerified: true,
      breakGlass: false,
    });

    expect(revokeResult.status).toBe('COMMITTED');
    expect(revokeResult.body.status).toBe('REVOKED');

    const db = connection.db!;
    const op1Assignment = await db
      .collection('platform_authority_assignments')
      .findOne({ subjectUserId: targetUserId1 });
    expect(op1Assignment?.status).toBe('REVOKED');

    const op2Assignment = await db
      .collection('platform_authority_assignments')
      .findOne({ subjectUserId: targetUserId2 });
    expect(op2Assignment?.status).toBe('ACTIVE');
  });

  it('rolls back entire transaction if audit log write fails', async () => {
    // Spy on useDb to force error on audit write
    const originalUseDb = connection.useDb.bind(connection);
    jest
      .spyOn(connection, 'useDb')
      .mockImplementation(
        (
          dbName: string,
          options?: { useCache?: boolean; noListener?: boolean },
        ) => {
          if (dbName === auditDatabaseName) {
            return {
              collection: () => ({
                insertOne: () => {
                  return Promise.reject(
                    new Error('Simulated atomic audit write failure'),
                  );
                },
              }),
            } as unknown as ReturnType<typeof originalUseDb>;
          }
          return originalUseDb(dbName, options);
        },
      );

    await expect(
      repository.execute({
        operationId: 'op-audit-failure-rollback',
        operationType: 'GRANT',
        targetUserId: targetUserId1.toHexString(),
        permission: 'organization.create',
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'ATOMIC_FAILURE_TEST',
        mfaVerified: true,
      }),
    ).rejects.toThrow();

    // Verify ROLLBACK: no assignment document, no ledger document
    const db = connection.db!;
    const assignment = await db
      .collection('platform_authority_assignments')
      .findOne({ subjectUserId: targetUserId1 });
    expect(assignment).toBeNull();

    const ledger = await db
      .collection('platform_authority_change_operations')
      .findOne({ operationId: 'op-audit-failure-rollback' });
    expect(ledger).toBeNull();
  });
});
