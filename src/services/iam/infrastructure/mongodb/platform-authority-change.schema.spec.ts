import { model, Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

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

  it('rejects malformed payloadHash', () => {
    const doc = new Operation({
      operationId: 'op-ledger-02',
      payloadHash: 'short-hash',
      actorUserId: new Types.ObjectId(),
      issuerUserId: new Types.ObjectId(),
      operationType: 'BOOTSTRAP',
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
