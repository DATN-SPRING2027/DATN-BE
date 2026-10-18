import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import { PlatformAuthorityLegacyAdoptionService } from '../../application/platform/platform-authority-legacy-adoption.service';
import {
  PLATFORM_AUTHORITY_LEGACY_ADOPTION_ACTOR_EMAIL,
  PLATFORM_AUTHORITY_LEGACY_ADOPTION_ISSUER_EMAIL,
  PLATFORM_AUTHORITY_LEGACY_ADOPTION_OPERATION_TYPE,
  PLATFORM_AUTHORITY_LEGACY_ADOPTION_TARGET_EMAIL,
  MongoPlatformAuthorityLegacyAdoptionRepository,
} from './platform-authority-legacy-adoption.repository';
import { MongoPlatformAuthorityChangeRepository } from './platform-authority-change.repository';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import {
  hashAssignmentSnapshot,
  PLATFORM_AUTHORITY_BUNDLES,
} from '../../application/platform/platform-authority-change.types';
import type { PlatformAuthorityChangeResultBody } from '../../application/platform/platform-authority-change.types';
import { PLATFORM_V1_PERMISSIONS } from '../../application/authorization/authorization.policy';

interface LedgerFixture {
  operationType: string;
  bundleVersion: string;
  targetUserId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  issuerUserId: Types.ObjectId;
  permissions: string[];
  scope: string;
  status: string;
  resultBody: PlatformAuthorityChangeResultBody;
}

interface AssignmentFixture {
  _id: Types.ObjectId;
  grantedAt: Date;
  grantedBy: Types.ObjectId;
  permission: string;
  status: string;
  provenanceOperationId?: string;
}

interface AuditFixture {
  action: string;
  targetResource: string;
  targetUserId: string;
  actorUserId: string;
  issuerUserId: string;
  scope: string;
  permissions: string[];
  metadata: {
    adoptedLegacyAssignmentIds: string[];
    createdV2AssignmentIds: string[];
  };
}

describe('Platform authority legacy adoption transactional integration', () => {
  jest.setTimeout(120_000);

  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let repository: MongoPlatformAuthorityLegacyAdoptionRepository;
  let service: PlatformAuthorityLegacyAdoptionService;
  let changeRepository: MongoPlatformAuthorityChangeRepository;
  let actorId: Types.ObjectId;
  let issuerId: Types.ObjectId;
  let targetId: Types.ObjectId;
  let originalEnvironment: Record<string, string | undefined>;

  const auditDatabaseName = 'continuum_audit';
  const operationId = () => randomUUID();
  const assignmentCollection = () =>
    connection.db!.collection('platform_authority_assignments');
  const operationCollection = () =>
    connection.db!.collection('platform_authority_change_operations');
  const auditCollection = () =>
    connection.useDb(auditDatabaseName).collection('audit_logs_iam');

  const snapshotHash = async () => {
    const rows = await assignmentCollection()
      .find({ subjectUserId: targetId, scope: 'PLATFORM' })
      .toArray();
    return hashAssignmentSnapshot(
      rows.map((row) => ({
        assignmentId: String(row._id),
        permission: String(row.permission),
        scope: String(row.scope),
        status: String(row.status),
        grantedAt: row.grantedAt as Date,
        grantedBy: String(row.grantedBy),
        expiresAt: (row.expiresAt as Date | null | undefined) ?? null,
        revokedAt: (row.revokedAt as Date | null | undefined) ?? null,
        revokedBy: row.revokedBy ? String(row.revokedBy) : null,
        provenanceOperationId:
          (row.provenanceOperationId as string | null | undefined) ?? null,
      })),
    );
  };

  const seedLegacyV1 = async () => {
    await assignmentCollection().insertMany(
      PLATFORM_V1_PERMISSIONS.map((permission) => ({
        _id: new Types.ObjectId(),
        subjectUserId: targetId,
        permission,
        scope: 'PLATFORM',
        status: 'ACTIVE',
        grantedAt: new Date('2026-10-10T08:00:00.000Z'),
        grantedBy: issuerId,
        expiresAt: null,
        revokedAt: null,
        revokedBy: null,
      })),
    );
  };

  const inspectAndAdopt = async (id = operationId()) => {
    const preflight = await service.inspect();
    expect(preflight.ready).toBe(true);
    expect(preflight.expectedCurrentSnapshotHash).toMatch(/^[a-f\d]{64}$/);
    return service.adopt({
      operationId: id,
      actorUserId: preflight.actorUserId!,
      issuerUserId: preflight.issuerUserId!,
      expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash!,
      now: new Date('2026-10-18T00:00:00.000Z'),
    });
  };

  beforeAll(async () => {
    originalEnvironment = {
      NODE_ENV: process.env.NODE_ENV,
      DATN_DB_ENV: process.env.DATN_DB_ENV,
      DATN_TEST_PLATFORM_AUTHORITY_ADOPTION:
        process.env.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION,
    };
    process.env.NODE_ENV = 'test';
    process.env.DATN_DB_ENV = 'test';
    process.env.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION = 'TEST_ONLY_ATLAS_DEV';
    replSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: {
        count: 1,
        name: 'test-rs-platform-authority-adoption',
        storageEngine: 'wiredTiger',
      },
    });
    connection = mongoose.createConnection(replSet.getUri(), {
      dbName: IAM_PERSISTENCE.databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    });
    await connection.asPromise();

    for (const name of [
      'users',
      'platform_authority_assignments',
      'platform_authority_change_operations',
      'platform_authority_change_locks',
    ]) {
      await connection.db!.createCollection(name);
      const definition = IAM_PERSISTENCE.collections.find(
        (collection) => collection.name === name,
      );
      if (definition) {
        await connection
          .model(
            `${IAM_PERSISTENCE.databaseName}_${name}`,
            createCollectionSchema(definition),
          )
          .createIndexes();
      }
    }
    await connection
      .useDb(auditDatabaseName)
      .createCollection('audit_logs_iam');

    repository = new MongoPlatformAuthorityLegacyAdoptionRepository(
      connection,
      auditDatabaseName,
    );
    service = new PlatformAuthorityLegacyAdoptionService(repository);
    changeRepository = new MongoPlatformAuthorityChangeRepository(
      connection,
      auditDatabaseName,
    );
  });

  afterAll(async () => {
    await connection?.close();
    await replSet?.stop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await connection.db!.command({
      collMod: 'platform_authority_change_operations',
      validator: {},
    });
    await connection.useDb(auditDatabaseName).db!.command({
      collMod: 'audit_logs_iam',
      validator: {},
    });
    await connection.db!.collection('users').deleteMany({});
    await assignmentCollection().deleteMany({});
    await operationCollection().deleteMany({});
    await connection
      .db!.collection('platform_authority_change_locks')
      .deleteMany({});
    await auditCollection().deleteMany({});

    actorId = new Types.ObjectId();
    issuerId = new Types.ObjectId();
    targetId = new Types.ObjectId();
    await connection.db!.collection('users').insertMany([
      {
        _id: actorId,
        email: PLATFORM_AUTHORITY_LEGACY_ADOPTION_ACTOR_EMAIL,
        fullName: 'Development Test Actor',
        status: 'ACTIVE',
      },
      {
        _id: issuerId,
        email: PLATFORM_AUTHORITY_LEGACY_ADOPTION_ISSUER_EMAIL,
        fullName: 'Development Test Issuer',
        status: 'ACTIVE',
      },
      {
        _id: targetId,
        email: PLATFORM_AUTHORITY_LEGACY_ADOPTION_TARGET_EMAIL,
        fullName: 'Platform Operator',
        status: 'ACTIVE',
      },
    ]);
    await connection
      .db!.collection('platform_authority_change_locks')
      .insertOne({
        permission: 'PLATFORM_OPERATOR_LIFECYCLE',
        scope: 'PLATFORM',
        version: 0,
      });
    await seedLegacyV1();
  });

  it('preflights the exact target and fixed active actor/issuer fixtures', async () => {
    const preflight = await service.inspect();
    expect(preflight).toMatchObject({
      targetEmail: PLATFORM_AUTHORITY_LEGACY_ADOPTION_TARGET_EMAIL,
      targetUserId: targetId.toHexString(),
      targetStatus: 'ACTIVE',
      actorUserId: actorId.toHexString(),
      actorStatus: 'ACTIVE',
      issuerUserId: issuerId.toHexString(),
      issuerStatus: 'ACTIVE',
      assignmentCount: 7,
      ready: true,
      blockers: [],
    });
  });

  it('rejects a target that is not ACTIVE', async () => {
    await connection
      .db!.collection('users')
      .updateOne({ _id: targetId }, { $set: { status: 'SUSPENDED' } });
    const preflight = await service.inspect();
    expect(preflight.ready).toBe(false);
    expect(preflight.blockers).toContain('TARGET_INACTIVE');
    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: preflight.actorUserId!,
        issuerUserId: preflight.issuerUserId!,
        expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({ response: { code: 'TARGET_USER_INACTIVE' } });
    expect(await operationCollection().countDocuments({})).toBe(0);
    expect(await auditCollection().countDocuments({})).toBe(0);
  });

  it('requires all seven legacy rows to have no provenance before explicit adoption', async () => {
    await assignmentCollection().updateOne(
      { subjectUserId: targetId, permission: PLATFORM_V1_PERMISSIONS[0] },
      { $set: { provenanceOperationId: 'unverified-legacy-provenance' } },
    );
    const preflight = await service.inspect();
    expect(preflight.ready).toBe(false);
    expect(preflight.blockers).toContain('LEGACY_V1_ASSIGNMENT_CONFLICT');
    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: preflight.actorUserId!,
        issuerUserId: preflight.issuerUserId!,
        expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({
      response: { code: 'LEGACY_ASSIGNMENT_CONFLICT' },
    });
    expect(await operationCollection().countDocuments({})).toBe(0);
    expect(await auditCollection().countDocuments({})).toBe(0);
  });

  it('commits all 25 V2 assignments, genuine adoption provenance, ledger, and audit atomically', async () => {
    const id = operationId();
    const originalRowsValue: unknown = await assignmentCollection()
      .find({ subjectUserId: targetId })
      .toArray();
    const originalRows = originalRowsValue as AssignmentFixture[];
    const result = await inspectAndAdopt(id);

    expect(result).toMatchObject({
      operationId: id,
      status: 'COMMITTED',
      httpStatus: 200,
      replayed: false,
      body: { status: 'ACTIVE', scope: 'PLATFORM' },
    });
    expect(result.body.assignments).toHaveLength(25);
    expect(result.body.assignments.map(({ permission }) => permission)).toEqual(
      [...PLATFORM_AUTHORITY_BUNDLES.V2].sort(),
    );

    const rowsValue: unknown = await assignmentCollection()
      .find({ subjectUserId: targetId, scope: 'PLATFORM' })
      .toArray();
    const rows = rowsValue as AssignmentFixture[];
    expect(rows).toHaveLength(25);
    for (const original of originalRows) {
      const adopted = rows.find((row) => row._id.equals(original._id));
      expect(adopted).toMatchObject({
        status: 'ACTIVE',
        grantedAt: original.grantedAt,
        grantedBy: original.grantedBy,
        provenanceOperationId: id,
      });
    }
    expect(rows.filter((row) => row.provenanceOperationId === id)).toHaveLength(
      25,
    );

    const ledgerDocument: unknown = await operationCollection().findOne({
      operationId: id,
    });
    const ledger = ledgerDocument as LedgerFixture | null;
    expect(ledger).toMatchObject({
      operationType: PLATFORM_AUTHORITY_LEGACY_ADOPTION_OPERATION_TYPE,
      bundleVersion: 'V2',
      targetUserId: targetId,
      actorUserId: actorId,
      issuerUserId: issuerId,
      permissions: [...PLATFORM_AUTHORITY_BUNDLES.V2],
      scope: 'PLATFORM',
      status: 'COMMITTED',
    });
    expect(ledger?.resultBody.assignments).toHaveLength(25);

    const auditDocument: unknown = await auditCollection().findOne({
      operationId: id,
    });
    const audit = auditDocument as AuditFixture | null;
    expect(audit).toMatchObject({
      action: 'platform.authority.legacy-adopted',
      targetResource: 'PLATFORM_AUTHORITY',
      targetUserId: targetId.toHexString(),
      actorUserId: actorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      scope: 'PLATFORM',
      permissions: [...PLATFORM_AUTHORITY_BUNDLES.V2],
      metadata: {
        adoptionType: 'LEGACY_V1_TO_V2',
      },
    });
    expect(audit?.metadata.adoptedLegacyAssignmentIds.sort()).toEqual(
      originalRows.map((row) => String(row._id)).sort(),
    );
    expect(audit?.metadata.createdV2AssignmentIds).toHaveLength(18);
  });

  it('replays the same operation once and rejects an idempotency key with another payload', async () => {
    const id = operationId();
    const preflight = await service.inspect();
    const command = {
      operationId: id,
      actorUserId: preflight.actorUserId!,
      issuerUserId: preflight.issuerUserId!,
      expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash!,
      now: new Date('2026-10-18T00:00:00.000Z'),
    };
    const first = await service.adopt(command);
    const replay = await service.adopt(command);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
    expect(
      await operationCollection().countDocuments({ operationId: id }),
    ).toBe(1);
    expect(await auditCollection().countDocuments({ operationId: id })).toBe(1);

    await expect(
      service.adopt({
        ...command,
        expectedCurrentSnapshotHash: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('rejects a stale full-snapshot CAS without changing any assignment', async () => {
    const preflight = await service.inspect();
    await assignmentCollection().updateOne(
      { subjectUserId: targetId, permission: 'organization.create' },
      { $set: { grantedAt: new Date('2026-10-11T08:00:00.000Z') } },
    );
    const before = await assignmentCollection()
      .find({ subjectUserId: targetId })
      .toArray();

    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: preflight.actorUserId!,
        issuerUserId: preflight.issuerUserId!,
        expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({ response: { code: 'PLATFORM_AUTHORITY_STALE' } });

    const after = await assignmentCollection()
      .find({ subjectUserId: targetId })
      .toArray();
    expect(after).toEqual(before);
    expect(await operationCollection().countDocuments({})).toBe(0);
    expect(await auditCollection().countDocuments({})).toBe(0);
  });

  it('keeps adopted provenance valid for the existing V2 lifecycle repository', async () => {
    await inspectAndAdopt();
    const expectedCurrentSnapshotHash = await snapshotHash();

    await expect(
      changeRepository.execute({
        operationId: operationId(),
        operationType: 'REGRANT',
        bundleVersion: 'V2',
        targetUserId: targetId.toHexString(),
        scope: 'PLATFORM',
        actorUserId: actorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        expectedCurrentSnapshotHash,
        reasonCode: 'PO_AUTH_01_REGRANT',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_AUTHORITY_ALREADY_ACTIVE' },
    });
    expect(await operationCollection().countDocuments({})).toBe(1);
    expect(await auditCollection().countDocuments({})).toBe(1);
  });

  it('rolls back assignment and lock changes when the operation ledger rejects the adoption', async () => {
    await connection.db!.command({
      collMod: 'platform_authority_change_operations',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          properties: { operationType: { enum: ['REJECTED'] } },
        },
      },
    });
    const preflight = await service.inspect();

    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: preflight.actorUserId!,
        issuerUserId: preflight.issuerUserId!,
        expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_AUTHORITY_MUTATION_FAILED' },
    });

    const rows = await assignmentCollection()
      .find({ subjectUserId: targetId })
      .toArray();
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => !row.provenanceOperationId)).toBe(true);
    expect(await operationCollection().countDocuments({})).toBe(0);
    expect(await auditCollection().countDocuments({})).toBe(0);
    expect(
      (
        await connection
          .db!.collection('platform_authority_change_locks')
          .findOne({
            permission: 'PLATFORM_OPERATOR_LIFECYCLE',
          })
      )?.version,
    ).toBe(0);
  });

  it('rolls back assignments and ledger when the audit insert fails', async () => {
    await connection.useDb(auditDatabaseName).db!.command({
      collMod: 'audit_logs_iam',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          properties: { action: { enum: ['REJECTED'] } },
        },
      },
    });
    const preflight = await service.inspect();

    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: preflight.actorUserId!,
        issuerUserId: preflight.issuerUserId!,
        expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_AUTHORITY_MUTATION_FAILED' },
    });

    expect(
      await assignmentCollection().countDocuments({ subjectUserId: targetId }),
    ).toBe(7);
    expect(
      await assignmentCollection().countDocuments({
        subjectUserId: targetId,
        provenanceOperationId: { $exists: true },
      }),
    ).toBe(0);
    expect(await operationCollection().countDocuments({})).toBe(0);
    expect(await auditCollection().countDocuments({})).toBe(0);
  });

  it('rejects missing targets and actor/issuer reuse of the target identity', async () => {
    const preflight = await service.inspect();
    await connection.db!.collection('users').deleteOne({ _id: targetId });
    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: preflight.actorUserId!,
        issuerUserId: preflight.issuerUserId!,
        expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({ response: { code: 'TARGET_USER_NOT_FOUND' } });

    await connection.db!.collection('users').insertOne({
      _id: targetId,
      email: PLATFORM_AUTHORITY_LEGACY_ADOPTION_TARGET_EMAIL,
      fullName: 'Platform Operator',
      status: 'ACTIVE',
    });
    const fresh = await service.inspect();
    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: fresh.targetUserId!,
        issuerUserId: fresh.issuerUserId!,
        expectedCurrentSnapshotHash: fresh.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({ response: { code: 'SELF_GRANT_PROHIBITED' } });
    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: fresh.actorUserId!,
        issuerUserId: fresh.targetUserId!,
        expectedCurrentSnapshotHash: fresh.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({ response: { code: 'SELF_GRANT_PROHIBITED' } });
  });

  it('rejects inactive actor or issuer fixtures during preflight and mutation', async () => {
    await connection
      .db!.collection('users')
      .updateOne({ _id: actorId }, { $set: { status: 'SUSPENDED' } });
    const actorPreflight = await service.inspect();
    expect(actorPreflight.ready).toBe(false);
    expect(actorPreflight.blockers).toContain('ACTOR_INACTIVE');
    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: actorPreflight.actorUserId!,
        issuerUserId: actorPreflight.issuerUserId!,
        expectedCurrentSnapshotHash:
          actorPreflight.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({ response: { code: 'ACTOR_INACTIVE' } });

    await connection
      .db!.collection('users')
      .updateOne({ _id: actorId }, { $set: { status: 'ACTIVE' } });
    await connection
      .db!.collection('users')
      .updateOne({ _id: issuerId }, { $set: { status: 'SUSPENDED' } });
    const issuerPreflight = await service.inspect();
    expect(issuerPreflight.ready).toBe(false);
    expect(issuerPreflight.blockers).toContain('ISSUER_INACTIVE');
    await expect(
      service.adopt({
        operationId: operationId(),
        actorUserId: issuerPreflight.actorUserId!,
        issuerUserId: issuerPreflight.issuerUserId!,
        expectedCurrentSnapshotHash:
          issuerPreflight.expectedCurrentSnapshotHash!,
      }),
    ).rejects.toMatchObject({ response: { code: 'ISSUER_INACTIVE' } });
    expect(await operationCollection().countDocuments({})).toBe(0);
    expect(await auditCollection().countDocuments({})).toBe(0);
  });

  it('does not let the general V2 expansion silently adopt legacy V1 rows', async () => {
    const preflight = await service.inspect();
    await expect(
      changeRepository.execute({
        operationId: operationId(),
        operationType: 'V2_EXPAND',
        bundleVersion: 'V2',
        targetUserId: targetId.toHexString(),
        scope: 'PLATFORM',
        actorUserId: preflight.actorUserId!,
        issuerUserId: preflight.issuerUserId!,
        expectedCurrentSnapshotHash: preflight.expectedCurrentSnapshotHash!,
        reasonCode: 'PO_AUTH_01_V2_EXPAND',
      }),
    ).rejects.toMatchObject({
      response: { code: 'LEGACY_ASSIGNMENT_CONFLICT' },
    });
    expect(
      await assignmentCollection().countDocuments({ subjectUserId: targetId }),
    ).toBe(7);
    expect(await operationCollection().countDocuments({})).toBe(0);
    expect(await auditCollection().countDocuments({})).toBe(0);
  });

  it('rejects non-fixed audit database injection before reading or writing', async () => {
    const wrongDatabaseRepository =
      new MongoPlatformAuthorityLegacyAdoptionRepository(
        connection,
        'other_audit',
      );
    await expect(wrongDatabaseRepository.inspect()).rejects.toMatchObject({
      response: { code: 'UNAPPROVED_DATABASE' },
    });
    expect(await operationCollection().countDocuments({})).toBe(0);
  });

  it('rejects a non-fixed IAM database before reading or writing', async () => {
    const wrongDatabaseRepository =
      new MongoPlatformAuthorityLegacyAdoptionRepository(
        connection.useDb('continuum_db'),
        auditDatabaseName,
      );
    await expect(wrongDatabaseRepository.inspect()).rejects.toMatchObject({
      response: { code: 'UNAPPROVED_DATABASE' },
    });
    expect(await operationCollection().countDocuments({})).toBe(0);
  });

  it('fails closed when the operation idempotency index is absent', async () => {
    await connection
      .db!.collection('platform_authority_change_operations')
      .dropIndex('platform_authority_operation_id');
    await expect(service.inspect()).rejects.toMatchObject({
      response: { code: 'PLATFORM_AUTHORITY_STORAGE_UNAVAILABLE' },
    });
    await connection.models[
      `${IAM_PERSISTENCE.databaseName}_platform_authority_change_operations`
    ].createIndexes();
  });

  it('keeps the repository unavailable without the TEST_ONLY runtime marker', async () => {
    const marker = process.env.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION;
    delete process.env.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION;
    await expect(repository.inspect()).rejects.toMatchObject({
      response: { code: 'TEST_ONLY_ADOPTION_DISABLED' },
    });
    if (marker) process.env.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION = marker;
    expect(await operationCollection().countDocuments({})).toBe(0);
  });
});
