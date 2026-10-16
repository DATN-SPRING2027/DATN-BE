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
          { targetUserId: 1, permission: 1, committedAt: -1 },
          expect.objectContaining({
            name: 'platform_authority_operation_target',
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
      operationId: 'op-ledger-01',
      payloadHash: 'a'.repeat(64),
      actorUserId: new Types.ObjectId(),
      issuerUserId: new Types.ObjectId(),
      operationType: 'GRANT',
      targetUserId: new Types.ObjectId(),
      permission: 'organization.create',
      scope: 'PLATFORM',
      auditEventId: 'evt-01',
      status: 'COMMITTED',
      httpStatus: 201,
      resultBody: {
        operationId: 'op-ledger-01',
        assignmentId: new Types.ObjectId().toHexString(),
        targetUserId: new Types.ObjectId().toHexString(),
        permission: 'organization.create',
        scope: 'PLATFORM',
        status: 'ACTIVE',
      },
      committedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    });
    expect(valid.validateSync()).toBeUndefined();
  });

  it('rejects malformed payloadHash', () => {
    const doc = new Operation({
      operationId: 'op-ledger-02',
      payloadHash: 'short-hash',
      actorUserId: new Types.ObjectId(),
      issuerUserId: new Types.ObjectId(),
      operationType: 'GRANT',
      targetUserId: new Types.ObjectId(),
      permission: 'organization.create',
      scope: 'PLATFORM',
      auditEventId: 'evt-02',
      status: 'COMMITTED',
      httpStatus: 201,
      resultBody: {},
      committedAt: new Date(),
      expiresAt: new Date(),
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
      permission: 'platform.configuration.read',
      scope: 'PLATFORM',
      auditEventId: 'evt-03',
      status: 'COMMITTED',
      httpStatus: 201,
      resultBody: {},
      committedAt: new Date(),
      expiresAt: new Date(),
    });
    const error = doc.validateSync();
    expect(error).toBeDefined();
    expect(error?.errors.operationType).toBeDefined();
    expect(error?.errors.permission).toBeDefined();
  });
});
