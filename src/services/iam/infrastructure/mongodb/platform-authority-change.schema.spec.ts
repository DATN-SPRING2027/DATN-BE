import { model, Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

const platformA04Permissions = [
  'organization.create',
  'platform.health.read',
  'platform.audit.read',
] as const;
const platformV1Permissions = [
  ...platformA04Permissions,
  'platform.organizations.organization.read',
  'platform.users.account.read',
  'platform.memberships.membership.read',
  'platform.memberships.lifecycle.manage',
] as const;
const platformV2Permissions = [
  ...platformV1Permissions,
  'platform.users.account.manage',
  'platform.sessions.session.read',
  'platform.sessions.session.manage',
  'platform.organizations.organization.manage',
  'platform.memberships.invitation.manage',
  'platform.memberships.role.manage',
  'platform.projects.project.read',
  'platform.projects.project.manage',
  'platform.dashboard.summary.read',
  'platform.services.service.read',
  'platform.jobs.job.read',
  'platform.jobs.job.manage',
  'platform.ai.operations.read',
  'platform.integrations.integration.read',
  'platform.integrations.integration.manage',
  'platform.incidents.incident.read',
  'platform.incidents.incident.manage',
  'platform.diagnostics.trace.read',
] as const;

describe('platform_authority_change_operations persistence contract', () => {
  const definition = IAM_PERSISTENCE.collections.find(
    (collection) => collection.name === 'platform_authority_change_operations',
  );
  const schema = createCollectionSchema(definition!);
  const Operation = model(
    'PlatformAuthorityChangeOperationContractSpec',
    schema,
  );

  it('declares unique operationId index and lookup indexes', () => {
    expect(definition).toBeDefined();
    expect(schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { operationId: 1 },
          expect.objectContaining({
            name: 'platform_authority_operation_id',
            unique: true,
          }),
        ],
        [
          { targetUserId: 1, committedAt: -1 },
          expect.objectContaining({
            name: 'platform_authority_operation_target_v2',
          }),
        ],
        [
          { actorUserId: 1, committedAt: -1 },
          expect.objectContaining({
            name: 'platform_authority_operation_actor',
          }),
        ],
      ]),
    );
  });

  it('accepts valid operation ledger document', () => {
    const valid = new Operation({
      operationId: '00000000-0000-4000-8000-000000000001',
      payloadHash: 'a'.repeat(64),
      actorUserId: new Types.ObjectId(),
      issuerUserId: new Types.ObjectId(),
      operationType: 'BOOTSTRAP',
      bundleVersion: 'A04',
      targetUserId: new Types.ObjectId(),
      permissions: [
        'organization.create',
        'platform.health.read',
        'platform.audit.read',
      ],
      scope: 'PLATFORM',
      auditEventId: 'evt-01',
      status: 'COMMITTED',
      httpStatus: 201,
      resultBody: {
        operationId: '00000000-0000-4000-8000-000000000001',
        targetUserId: new Types.ObjectId().toHexString(),
        scope: 'PLATFORM',
        status: 'ACTIVE',
        assignments: [
          'organization.create',
          'platform.health.read',
          'platform.audit.read',
        ].map((permission) => ({
          assignmentId: new Types.ObjectId().toHexString(),
          permission,
          status: 'ACTIVE',
        })),
      },
      committedAt: new Date(),
    });
    expect(valid.validateSync()).toBeUndefined();
  });

  it('defaults the bundle version for legacy A-04 operation writers', () => {
    const legacyWriter = new Operation({
      operationId: '00000000-0000-4000-8000-000000000008',
      payloadHash: 'c'.repeat(64),
      actorUserId: new Types.ObjectId(),
      issuerUserId: new Types.ObjectId(),
      operationType: 'BOOTSTRAP',
      targetUserId: new Types.ObjectId(),
      permissions: [...platformA04Permissions],
      scope: 'PLATFORM',
      auditEventId: 'evt-legacy-a04',
      status: 'COMMITTED',
      httpStatus: 201,
      resultBody: {},
      committedAt: new Date(),
    });

    expect(legacyWriter.bundleVersion).toBe('A04');
    expect(legacyWriter.validateSync()).toBeUndefined();
  });

  it('rejects malformed payloadHash', () => {
    const doc = new Operation({
      operationId: 'op-ledger-02',
      payloadHash: 'short-hash',
      actorUserId: new Types.ObjectId(),
      issuerUserId: new Types.ObjectId(),
      operationType: 'BOOTSTRAP',
      bundleVersion: 'A04',
      targetUserId: new Types.ObjectId(),
      permissions: [
        'organization.create',
        'platform.health.read',
        'platform.audit.read',
      ],
      scope: 'PLATFORM',
      auditEventId: 'evt-02',
      status: 'COMMITTED',
      httpStatus: 201,
      resultBody: {},
      committedAt: new Date(),
    });
    const error = doc.validateSync();
    expect(error).toBeDefined();
    expect(error?.errors.payloadHash).toBeDefined();
  });

  it('rejects unsupported permission or operationType', () => {
    const doc = new Operation({
      operationId: 'op-ledger-03',
      payloadHash: 'b'.repeat(64),
      actorUserId: new Types.ObjectId(),
      issuerUserId: new Types.ObjectId(),
      operationType: 'INVALID_OP',
      bundleVersion: 'A04',
      targetUserId: new Types.ObjectId(),
      permissions: ['platform.configuration.read'],
      scope: 'PLATFORM',
      auditEventId: 'evt-03',
      status: 'COMMITTED',
      httpStatus: 201,
      resultBody: {},
      committedAt: new Date(),
    });
    const error = doc.validateSync();
    expect(error).toBeDefined();
    expect(error?.errors.operationType).toBeDefined();
    expect(error?.errors.permissions).toBeDefined();
  });

  it('accepts complete V1 and V2 bundles and rejects partial bundles', () => {
    const makeOperation = (
      operationType: string,
      bundleVersion: string,
      permissions: readonly string[],
    ) =>
      new Operation({
        operationId: '00000000-0000-4000-8000-000000000007',
        payloadHash: 'f'.repeat(64),
        actorUserId: new Types.ObjectId(),
        issuerUserId: new Types.ObjectId(),
        operationType,
        bundleVersion,
        targetUserId: new Types.ObjectId(),
        permissions: [...permissions],
        scope: 'PLATFORM',
        auditEventId: 'evt-expanded',
        status: 'COMMITTED',
        httpStatus: 200,
        resultBody: {},
        committedAt: new Date(),
      });

    expect(
      makeOperation('V1_EXPAND', 'V1', platformV1Permissions).validateSync(),
    ).toBeUndefined();
    expect(
      makeOperation('V2_EXPAND', 'V2', platformV2Permissions).validateSync(),
    ).toBeUndefined();
    expect(
      makeOperation(
        'V1_EXPAND',
        'V1',
        platformV1Permissions.slice(0, -1),
      ).validateSync()?.errors.permissions,
    ).toBeDefined();
  });
});

describe('refresh session lifecycle fence schema', () => {
  const definition = IAM_PERSISTENCE.collections.find(
    (collection) => collection.name === 'refresh_sessions',
  );
  const schema = createCollectionSchema(definition!);
  const RefreshSession = model('RefreshSessionFenceContractSpec', schema);

  it('supports optional sessionId and a non-negative safe integer userFence', () => {
    expect(definition).toBeDefined();
    const valid = new RefreshSession({
      userId: new Types.ObjectId(),
      sessionId: 'session-01',
      userFence: 1,
      context: 'ACCOUNT',
      tokenHash: 'a'.repeat(64),
      isRevoked: false,
      expiresAt: new Date(),
    });
    expect(valid.validateSync()).toBeUndefined();

    const invalid = new RefreshSession({
      userId: new Types.ObjectId(),
      userFence: -1,
      context: 'ACCOUNT',
      tokenHash: 'b'.repeat(64),
      expiresAt: new Date(),
    });
    expect(invalid.validateSync()?.errors.userFence).toBeDefined();
  });
});

describe('platform_authority_change_locks persistence contract', () => {
  const definition = IAM_PERSISTENCE.collections.find(
    (collection) => collection.name === 'platform_authority_change_locks',
  );
  const schema = createCollectionSchema(definition!);

  it('declares one unique lock for each permission and scope', () => {
    expect(definition).toBeDefined();
    expect(schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { permission: 1, scope: 1 },
          expect.objectContaining({
            name: 'platform_authority_change_lock_key',
            unique: true,
          }),
        ],
      ]),
    );
  });
});
