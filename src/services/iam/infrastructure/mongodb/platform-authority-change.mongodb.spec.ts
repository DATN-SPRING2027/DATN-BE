import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import { MongoPlatformAuthorityChangeRepository } from './platform-authority-change.repository';
import { MongoPlatformAuditRepository } from './platform-audit.repository';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import {
  hashAssignmentSnapshot,
  PLATFORM_AUTHORITY_BUNDLES,
  PLATFORM_AUTHORITY_REASON_CODES,
  type PlatformAuthorityChangeCommand,
} from '../../application/platform/platform-authority-change.types';

type AuthorityAssignmentFixture = {
  _id: Types.ObjectId;
  permission: string;
  scope: string;
  status: string;
  grantedAt: Date;
  grantedBy: Types.ObjectId;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  revokedBy?: Types.ObjectId | null;
  provenanceOperationId?: string;
};

type RepositoryTestCommand = Omit<
  PlatformAuthorityChangeCommand,
  'bundleVersion' | 'expectedCurrentSnapshotHash'
> &
  Partial<
    Pick<
      PlatformAuthorityChangeCommand,
      'bundleVersion' | 'expectedCurrentSnapshotHash'
    >
  >;

const isCompletePlatformAuthorityBundle = (permissions: string[]) =>
  Object.values(PLATFORM_AUTHORITY_BUNDLES).some(
    (bundle) =>
      permissions.length === bundle.length &&
      new Set(permissions).size === bundle.length &&
      bundle.every((permission) => permissions.includes(permission)),
  );

// Keep this behavior suite on the expanded DB contract without mutating shared schemas.
const createAuthorityIntegrationSchema = (
  definition: (typeof IAM_PERSISTENCE.collections)[number],
) => {
  const schema = createCollectionSchema(definition).clone();
  if (definition.name !== 'platform_authority_change_operations') return schema;

  const authoritySchema = new mongoose.Schema(
    {
      ...schema.obj,
      operationType: {
        type: String,
        enum: [...Object.keys(PLATFORM_AUTHORITY_REASON_CODES)],
        required: true,
      },
      bundleVersion: {
        type: String,
        enum: [...Object.keys(PLATFORM_AUTHORITY_BUNDLES)],
        default: 'A04',
      },
      permissions: {
        type: [{ type: String, enum: [...PLATFORM_AUTHORITY_BUNDLES.V2] }],
        required: true,
        validate: {
          validator: isCompletePlatformAuthorityBundle,
          message:
            'permissions must contain one complete approved authority bundle.',
        },
      },
    },
    schema.options,
  );
  for (const [fields, options] of schema.indexes()) {
    authoritySchema.index(fields, options);
  }

  return authoritySchema;
};

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
  const snapshotHashesByOperation = new Map<string, string>();

  const currentSnapshotHash = async (targetUserId: string) => {
    const rows = (await connection
      .db!.collection('platform_authority_assignments')
      .find({
        subjectUserId: new Types.ObjectId(targetUserId),
        scope: 'PLATFORM',
      })
      .toArray()) as unknown as AuthorityAssignmentFixture[];
    return hashAssignmentSnapshot(
      rows.map((row) => ({
        assignmentId: row._id.toHexString(),
        permission: row.permission,
        scope: row.scope,
        status: row.status,
        grantedAt: row.grantedAt,
        grantedBy: row.grantedBy.toHexString(),
        expiresAt: row.expiresAt ?? null,
        revokedAt: row.revokedAt ?? null,
        revokedBy: row.revokedBy?.toHexString() ?? null,
        provenanceOperationId: row.provenanceOperationId ?? null,
      })),
    );
  };

  const executeChange = async (input: RepositoryTestCommand) => {
    const expectedCurrentSnapshotHash =
      input.expectedCurrentSnapshotHash ??
      snapshotHashesByOperation.get(input.operationId) ??
      (await currentSnapshotHash(input.targetUserId));
    snapshotHashesByOperation.set(
      input.operationId,
      expectedCurrentSnapshotHash,
    );
    return repository.execute({
      ...input,
      bundleVersion: input.bundleVersion ?? 'V1',
      expectedCurrentSnapshotHash,
    });
  };

  const seedLegacyA04Bundle = async (targetUserId: Types.ObjectId) => {
    const operationId = `00000000-0000-4000-8000-${targetUserId.toHexString().slice(-12)}`;
    const permissions = [
      'organization.create',
      'platform.health.read',
      'platform.audit.read',
    ];
    const assignments = permissions.map((permission) => ({
      _id: new Types.ObjectId(),
      subjectUserId: targetUserId,
      permission,
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      grantedBy: issuerId,
      expiresAt: null,
      revokedAt: null,
      revokedBy: null,
      provenanceOperationId: operationId,
    }));
    await connection
      .db!.collection('platform_authority_assignments')
      .insertMany(assignments);
    await connection
      .db!.collection('platform_authority_change_operations')
      .insertOne({
        operationId,
        payloadHash: 'a'.repeat(64),
        actorUserId: executorId,
        issuerUserId: issuerId,
        operationType: 'BOOTSTRAP',
        targetUserId,
        permissions,
        scope: 'PLATFORM',
        auditEventId: `audit-${operationId}`,
        status: 'COMMITTED',
        httpStatus: 201,
        resultBody: {
          operationId,
          targetUserId: targetUserId.toHexString(),
          scope: 'PLATFORM',
          status: 'ACTIVE',
          assignments: assignments.map((assignment) => ({
            assignmentId: assignment._id.toHexString(),
            permission: assignment.permission,
            status: 'ACTIVE',
          })),
        },
        committedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
    return assignments;
  };

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
      'platform_authority_change_locks',
    ];
    for (const name of collections) {
      await db.createCollection(name);
      const def = IAM_PERSISTENCE.collections.find((c) => c.name === name);
      if (def) {
        await connection
          .model(`continuum_iam_${name}`, createAuthorityIntegrationSchema(def))
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
    snapshotHashesByOperation.clear();
    const db = connection.db!;
    await db.collection('users').deleteMany({});
    await db.collection('platform_authority_assignments').deleteMany({});
    await db.collection('platform_authority_change_operations').deleteMany({});
    await db.collection('platform_authority_change_locks').deleteMany({});
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
      },
      {
        _id: issuerId,
        email: 'issuer@continuum.test',
        status: 'ACTIVE',
      },
      {
        _id: targetUserId1,
        email: 'target1@continuum.test',
        status: 'ACTIVE',
      },
      {
        _id: targetUserId2,
        email: 'target2@continuum.test',
        status: 'ACTIVE',
      },
    ]);
    await db
      .collection('platform_authority_change_locks')
      .insertMany(
        [
          'organization.create',
          'platform.health.read',
          'platform.audit.read',
          'PLATFORM_OPERATOR_LIFECYCLE',
        ].map((permission) => ({ permission, scope: 'PLATFORM', version: 0 })),
      );
  });

  it('atomically commits assignment, ledger, and audit on valid GRANT', async () => {
    const command: PlatformAuthorityChangeCommand = {
      operationId: '00000000-0000-4000-8000-000000000101',
      operationType: 'BOOTSTRAP',
      bundleVersion: 'V1',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      expectedCurrentSnapshotHash: hashAssignmentSnapshot([]),
      reasonCode: 'PO_AUTH_01_PROVISIONING',
    };

    const result = await executeChange(command);
    expect(result.status).toBe('COMMITTED');
    expect(result.httpStatus).toBe(201);
    expect(result.replayed).toBe(false);
    expect(result.body.assignments).toHaveLength(7);
    expect(result.body.assignments.map(({ permission }) => permission)).toEqual(
      [
        'organization.create',
        'platform.audit.read',
        'platform.health.read',
        'platform.memberships.lifecycle.manage',
        'platform.memberships.membership.read',
        'platform.organizations.organization.read',
        'platform.users.account.read',
      ],
    );
    expect(result.body.status).toBe('ACTIVE');

    const db = connection.db!;
    const assignment = await db
      .collection('platform_authority_assignments')
      .findOne({
        subjectUserId: targetUserId1,
        permission: 'organization.create',
      });
    expect(assignment).toBeDefined();
    expect(assignment?.status).toBe('ACTIVE');
    expect(assignment?.permission).toBe('organization.create');
    expect(String(assignment?.grantedBy)).toBe(issuerId.toHexString());

    const ledger = await db
      .collection('platform_authority_change_operations')
      .findOne({ operationId: '00000000-0000-4000-8000-000000000101' });
    expect(ledger).toBeDefined();
    expect(ledger?.status).toBe('COMMITTED');
    expect(String(ledger?.actorUserId)).toBe(executorId.toHexString());
    expect(String(ledger?.issuerUserId)).toBe(issuerId.toHexString());

    const auditDb = connection.useDb(auditDatabaseName, { useCache: true });
    const auditLogs = await auditDb
      .collection('audit_logs_iam')
      .find({ operationId: '00000000-0000-4000-8000-000000000101' })
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
          targetResourceId: targetUserId1.toHexString(),
          actorUserId: executorId.toHexString(),
        }),
      ]),
    );
  });

  it('idempotently replays previous result when called with same operationId and same payload', async () => {
    const command: RepositoryTestCommand = {
      operationId: '00000000-0000-4000-8000-000000000102',
      operationType: 'BOOTSTRAP',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'REPLAY_TEST',
    };

    const first = await executeChange(command);
    expect(first.replayed).toBe(false);

    const second = await executeChange(command);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);

    const db = connection.db!;
    expect(
      await db
        .collection('platform_authority_change_operations')
        .countDocuments({
          operationId: '00000000-0000-4000-8000-000000000102',
        }),
    ).toBe(1);
  });

  it('throws 409 Conflict when duplicate operationId is sent with different payload', async () => {
    const command: RepositoryTestCommand = {
      operationId: '00000000-0000-4000-8000-000000000103',
      operationType: 'BOOTSTRAP',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'FIRST_ATTEMPT',
    };
    await executeChange(command);

    await expect(
      executeChange({
        ...command,
        reasonCode: 'DIFFERENT_REASON_AND_PAYLOAD',
      }),
    ).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
  });

  it('enforces full-snapshot CAS: rejects a stale grant pre-state', async () => {
    await executeChange({
      operationId: '00000000-0000-4000-8000-000000000104',
      operationType: 'BOOTSTRAP',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'INITIAL_GRANT',
    });

    await expect(
      executeChange({
        operationId: '00000000-0000-4000-8000-000000000105',
        operationType: 'BOOTSTRAP',
        targetUserId: targetUserId1.toHexString(),
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        expectedCurrentSnapshotHash: hashAssignmentSnapshot([]),
        reasonCode: 'MISMATCH_TEST',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_AUTHORITY_STALE' },
    });
  });

  it('expands only a complete provenance-matched legacy A-04 bundle and preserves its assignment rows', async () => {
    const legacyRows = await seedLegacyA04Bundle(targetUserId1);
    const result = await executeChange({
      operationId: '00000000-0000-4000-8000-000000000120',
      operationType: 'V1_EXPAND',
      bundleVersion: 'V1',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'V1_EXPANSION',
    });

    expect(result.body.assignments).toHaveLength(7);
    const stored = await connection
      .db!.collection('platform_authority_assignments')
      .find({ subjectUserId: targetUserId1 })
      .toArray();
    expect(stored).toHaveLength(7);
    expect(
      legacyRows.every((row) =>
        stored.some(
          (candidate) => String(candidate._id) === row._id.toHexString(),
        ),
      ),
    ).toBe(true);
    expect(
      stored.filter((row) => row.provenanceOperationId === result.operationId),
    ).toHaveLength(4);
    const ledger = await connection
      .db!.collection('platform_authority_change_operations')
      .findOne({ operationId: result.operationId });
    expect(ledger?.operationType).toBe('V1_EXPAND');
    expect(ledger?.sourceOperationId).toBe(legacyRows[0].provenanceOperationId);
  });

  it('expands a complete V1 bundle to V2 without replacing existing assignments', async () => {
    const v1 = await executeChange({
      operationId: '00000000-0000-4000-8000-000000000121',
      operationType: 'BOOTSTRAP',
      bundleVersion: 'V1',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'INITIAL_V1',
    });
    const v1Ids = new Set(
      v1.body.assignments.map(({ assignmentId }) => assignmentId),
    );

    const v2 = await executeChange({
      operationId: '00000000-0000-4000-8000-000000000122',
      operationType: 'V2_EXPAND',
      bundleVersion: 'V2',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'PO_AUTH_01_V2_EXPAND',
    });

    expect(v2.body.assignments).toHaveLength(25);
    const stored = await connection
      .db!.collection('platform_authority_assignments')
      .find({ subjectUserId: targetUserId1 })
      .toArray();
    expect(stored).toHaveLength(25);
    expect(
      [...v1Ids].every((id) => stored.some((row) => String(row._id) === id)),
    ).toBe(true);
    expect(
      stored.filter((row) => row.provenanceOperationId === v2.operationId),
    ).toHaveLength(18);
    const ledger = await connection
      .db!.collection('platform_authority_change_operations')
      .findOne({ operationId: v2.operationId });
    expect(ledger?.operationType).toBe('V2_EXPAND');
    expect(ledger?.bundleVersion).toBe('V2');
    expect(ledger?.sourceOperationId).toBe(
      '00000000-0000-4000-8000-000000000121',
    );
  });

  it('blocks duplicate bootstrap when target already has a procedure-owned bundle', async () => {
    await executeChange({
      operationId: '00000000-0000-4000-8000-000000000106',
      operationType: 'BOOTSTRAP',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'INITIAL_GRANT',
    });

    await expect(
      executeChange({
        operationId: '00000000-0000-4000-8000-000000000107',
        operationType: 'BOOTSTRAP',
        targetUserId: targetUserId1.toHexString(),
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'DUPLICATE_ATTEMPT',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PLATFORM_AUTHORITY_ALREADY_ACTIVE' },
    });
  });

  it('blocks revoking the sole active operator even when an unapproved breakGlass flag is supplied', async () => {
    await executeChange({
      operationId: '00000000-0000-4000-8000-000000000108',
      operationType: 'BOOTSTRAP',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'SOLE_OPERATOR_SETUP',
    });

    // A command flag must not override the last-operator invariant.
    await expect(
      executeChange({
        operationId: '00000000-0000-4000-8000-000000000109',
        operationType: 'REVOKE',
        targetUserId: targetUserId1.toHexString(),
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'TRYING_REVOKE_LAST',
      }),
    ).rejects.toMatchObject({
      response: { code: 'LAST_OPERATOR_REQUIRED' },
    });

    await expect(
      executeChange({
        operationId: '00000000-0000-4000-8000-000000000110',
        operationType: 'REVOKE',
        targetUserId: targetUserId1.toHexString(),
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'EMERGENCY_DECOMMISSION_AUTHORIZED',
        breakGlass: true,
      } as unknown as RepositoryTestCommand),
    ).rejects.toMatchObject({
      response: { code: 'LAST_OPERATOR_REQUIRED' },
    });
    const assignment = await connection
      .db!.collection('platform_authority_assignments')
      .findOne({ subjectUserId: targetUserId1 });
    expect(assignment?.status).toBe('ACTIVE');
  });

  it('serializes concurrent revokes so one active operator remains', async () => {
    const permission = 'platform.health.read';
    await executeChange({
      operationId: '00000000-0000-4000-8000-000000000111',
      operationType: 'BOOTSTRAP',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'CONCURRENT_TEST_SETUP',
    });
    await executeChange({
      operationId: '00000000-0000-4000-8000-000000000112',
      operationType: 'BOOTSTRAP',
      targetUserId: targetUserId2.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'CONCURRENT_TEST_SETUP',
    });

    const outcomes = await Promise.allSettled([
      executeChange({
        operationId: '00000000-0000-4000-8000-000000000113',
        operationType: 'REVOKE',
        targetUserId: targetUserId1.toHexString(),
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'CONCURRENT_TEST_REVOKE',
      }),
      executeChange({
        operationId: '00000000-0000-4000-8000-000000000114',
        operationType: 'REVOKE',
        targetUserId: targetUserId2.toHexString(),
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'CONCURRENT_TEST_REVOKE',
      }),
    ]);

    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    const activeAssignments = await connection
      .model(`continuum_iam_platform_authority_assignments`)
      .countDocuments({ permission, scope: 'PLATFORM', status: 'ACTIVE' });
    expect(activeAssignments).toBe(1);
  });

  it('returns a generic 500 for persistence errors without exposing driver details', async () => {
    const operations = connection.model(
      'continuum_iam_platform_authority_change_operations',
    );
    const create = jest
      .spyOn(operations, 'create')
      .mockRejectedValueOnce(
        new Error('MongoServerError: private host and index'),
      );

    await expect(
      executeChange({
        operationId: '00000000-0000-4000-8000-000000000115',
        operationType: 'BOOTSTRAP',
        targetUserId: targetUserId1.toHexString(),
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'ERROR_TEST',
      }),
    ).rejects.toMatchObject({
      status: 500,
      response: {
        code: 'PLATFORM_AUTHORITY_MUTATION_FAILED',
        message: 'Platform authority mutation failed.',
      },
    });
    expect(create).toHaveBeenCalled();
    create.mockRestore();
  });

  it('allows revocation when multiple active operators exist', async () => {
    await executeChange({
      operationId: '00000000-0000-4000-8000-000000000116',
      operationType: 'BOOTSTRAP',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'OP1_SETUP',
    });

    await executeChange({
      operationId: '00000000-0000-4000-8000-000000000117',
      operationType: 'BOOTSTRAP',
      targetUserId: targetUserId2.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'OP2_SETUP',
    });

    const revokeResult = await executeChange({
      operationId: '00000000-0000-4000-8000-000000000118',
      operationType: 'REVOKE',
      targetUserId: targetUserId1.toHexString(),
      scope: 'PLATFORM',
      actorUserId: executorId.toHexString(),
      issuerUserId: issuerId.toHexString(),
      reasonCode: 'OP1_DEPARTURE',
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
      executeChange({
        operationId: '00000000-0000-4000-8000-000000000119',
        operationType: 'BOOTSTRAP',
        targetUserId: targetUserId1.toHexString(),
        scope: 'PLATFORM',
        actorUserId: executorId.toHexString(),
        issuerUserId: issuerId.toHexString(),
        reasonCode: 'ATOMIC_FAILURE_TEST',
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
      .findOne({ operationId: '00000000-0000-4000-8000-000000000119' });
    expect(ledger).toBeNull();
  });
});
