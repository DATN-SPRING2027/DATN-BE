import { model, Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

const schemaFor = (name: string) =>
  createCollectionSchema(
    IAM_PERSISTENCE.collections.find((entry) => entry.name === name)!,
  );
const Membership = model(
  'Datn87VersionedMembershipSpec',
  schemaFor('organization_memberships'),
);
const invitationSchema = schemaFor('organization_invitations');
const Invitation = model('Datn87VersionedInvitationSpec', invitationSchema);
const Organization = model(
  'Datn87OrganizationFenceSpec',
  schemaFor('organizations'),
);
const operationSchema = schemaFor('membership_operations');
const Operation = model('Datn87OperationSpec', operationSchema);
const operationId = new Types.ObjectId();
const membershipId = new Types.ObjectId();
const committedAt = new Date('2026-10-12T00:00:00.000Z');
const cachedOperation = {
  _id: operationId,
  actorUserId: new Types.ObjectId(),
  organizationId: new Types.ObjectId(),
  membershipId,
  targetUserId: new Types.ObjectId(),
  keyHash: 'a'.repeat(64),
  fingerprintHash: 'b'.repeat(64),
  command: 'SUSPEND',
  status: 'COMMITTED',
  httpStatus: 200,
  committedAt,
  expiresAt: new Date(committedAt.getTime() + 86_400_000),
};
const cachedResult = {
  operationId: String(operationId),
  membership: {
    id: String(membershipId),
    organizationId: String(cachedOperation.organizationId),
    userId: String(cachedOperation.targetUserId),
    status: 'SUSPENDED',
    version: 2,
  },
};
const pair = {
  organizationId: new Types.ObjectId(),
  userId: new Types.ObjectId(),
};
const invitation = {
  organizationId: pair.organizationId,
  email: 'member@example.test',
  invitedBy: new Types.ObjectId(),
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};
const v2 = {
  ...invitation,
  contractVersion: 2,
  membershipId: new Types.ObjectId(),
  targetUserId: pair.userId,
};

describe('DATN-87 independent lifecycle persistence', () => {
  it('separates business version from the internal Membership fence', () => {
    const row = new Membership({ ...pair, status: 'PENDING_INVITE' });
    expect(row.get('version')).toBe(1);
    expect(row.get('mutationFence')).toBe(0);
    expect(row.validateSync()).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe Membership version %s',
    (version) => {
      expect(
        new Membership({ ...pair, status: 'ACTIVE', version }).validateSync(),
      ).toBeDefined();
    },
  );

  it('preserves legacy Invitation shape without manufacturing a recipient relationship', () => {
    const row = new Invitation({
      ...invitation,
      roleCode: 'MEMBER',
      status: 'REVOKED',
    });
    expect(row.validateSync()).toBeUndefined();
    expect(row.get('contractVersion')).toBe(1);
    expect(row.get('version')).toBe(1);
    expect(row.get('membershipId')).toBeUndefined();
    expect(row.get('targetUserId')).toBeUndefined();
  });

  it.each(['PENDING', 'ACCEPTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED'])(
    'validates V2 Invitation state %s without an implicit role grant',
    (status) => {
      const row = new Invitation({ ...v2, status });
      expect(row.validateSync()).toBeUndefined();
      expect(row.get('roleCode')).toBeUndefined();
    },
  );

  it.each(['membershipId', 'targetUserId'])('requires %s for V2', (field) => {
    expect(
      new Invitation({
        ...v2,
        [field]: undefined,
        status: 'PENDING',
      }).validateSync(),
    ).toBeDefined();
  });

  it('rejects legacy REVOKED vocabulary and role grants on new V2 records', () => {
    expect(
      new Invitation({ ...v2, status: 'REVOKED' }).validateSync(),
    ).toBeDefined();
    expect(
      new Invitation({
        ...v2,
        status: 'PENDING',
        roleCode: 'ADMIN',
      }).validateSync(),
    ).toBeDefined();
  });

  it.each([0, 1.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe Invitation version %s',
    (version) => {
      expect(
        new Invitation({ ...v2, status: 'PENDING', version }).validateSync(),
      ).toBeDefined();
    },
  );

  it('provides an Organization fence without changing global account or Project policy', () => {
    const row = new Organization({ name: 'Test', slug: 'test', plan: 'FREE' });
    expect(row.get('membershipAdminRevision')).toBe(0);
    expect(row.validateSync()).toBeUndefined();
  });

  it('enforces one V2 pending invitation per long-lived Membership and preserves history', () => {
    expect(invitationSchema.indexes()).toContainEqual([
      { membershipId: 1 },
      expect.objectContaining({
        unique: true,
        name: 'uniq_pending_membership_v2',
        partialFilterExpression: { contractVersion: 2, status: 'PENDING' },
      }),
    ]);
    expect(
      invitationSchema
        .indexes()
        .some(([, options]) => 'expireAfterSeconds' in options),
    ).toBe(false);
  });
});

describe('DATN-87 immutable operation cache', () => {
  it.each([
    ['INVITE', 'PENDING_INVITE', 201],
    ['RESEND', 'PENDING_INVITE', 200],
    ['CANCEL', 'REMOVED', 200],
    ['ACCEPT', 'ACTIVE', 200],
    ['SUSPEND', 'SUSPENDED', 200],
    ['REMOVE', 'REMOVED', 200],
    ['RESUME', 'ACTIVE', 200],
    ['REINVITE', 'PENDING_INVITE', 200],
    ['RIGHTS_REVIEW', '', 201],
  ])(
    'binds cached HTTP status to %s success contract',
    (command, status, httpStatus) => {
      const resultBody =
        command === 'RIGHTS_REVIEW'
          ? {
              operationId: String(operationId),
              receipt: {
                id: String(new Types.ObjectId()),
                purpose: 'RIGHTS_REVIEW',
                targetMembershipVersion: 2,
                expiresAt: '2026-10-13T00:00:00.000Z',
              },
            }
          : {
              ...cachedResult,
              membership: { ...cachedResult.membership, status },
            };
      expect(
        new Operation({
          ...cachedOperation,
          command,
          httpStatus,
          resultBody,
        }).validateSync(),
      ).toBeUndefined();
      expect(
        new Operation({
          ...cachedOperation,
          command,
          httpStatus: httpStatus === 200 ? 201 : 200,
          resultBody,
        }).validateSync()?.errors.httpStatus,
      ).toBeDefined();
    },
  );

  it('accepts a scoped historical acknowledgement without current-state refresh', () => {
    expect(
      new Operation({
        ...cachedOperation,
        resultBody: cachedResult,
      }).validateSync(),
    ).toBeUndefined();
    expect(operationSchema.indexes()).toContainEqual([
      { actorUserId: 1, organizationId: 1, keyHash: 1 },
      expect.objectContaining({ unique: true }),
    ]);
  });

  it.each(['id', 'organizationId', 'userId'])(
    'rejects a result with a different scoped %s',
    (field) => {
      const resultBody = {
        ...cachedResult,
        membership: {
          ...cachedResult.membership,
          [field]: String(new Types.ObjectId()),
        },
      };
      expect(
        new Operation({ ...cachedOperation, resultBody }).validateSync(),
      ).toBeDefined();
    },
  );

  it('rejects an operation identifier or resulting state belonging to a different command', () => {
    expect(
      new Operation({
        ...cachedOperation,
        resultBody: {
          ...cachedResult,
          operationId: String(new Types.ObjectId()),
        },
      }).validateSync(),
    ).toBeDefined();
    expect(
      new Operation({
        ...cachedOperation,
        resultBody: {
          ...cachedResult,
          membership: { ...cachedResult.membership, status: 'ACTIVE' },
        },
      }).validateSync(),
    ).toBeDefined();
  });

  it.each(['email', 'passwordHash', 'deliveryStatus'])(
    'rejects unapproved %s in replay data',
    (field) => {
      expect(
        new Operation({
          ...cachedOperation,
          resultBody: { ...cachedResult, [field]: 'private' },
        }).validateSync(),
      ).toBeDefined();
      expect(
        new Operation({
          ...cachedOperation,
          resultBody: {
            ...cachedResult,
            membership: { ...cachedResult.membership, [field]: 'private' },
          },
        }).validateSync(),
      ).toBeDefined();
    },
  );

  it('enforces the24hour cache retention independently of Invitation7days', () => {
    expect(
      new Operation({
        ...cachedOperation,
        resultBody: cachedResult,
        expiresAt: new Date(committedAt.getTime() + 7 * 86_400_000),
      }).validateSync(),
    ).toBeDefined();
    expect(operationSchema.indexes()).toContainEqual([
      { expiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    ]);
  });

  it('rejects raw request/credential fields instead of storing them', () => {
    expect(
      () =>
        new Operation({
          ...cachedOperation,
          resultBody: cachedResult,
          rawRequest: { email: 'secret@example.test' },
        }),
    ).toThrow();
  });
});
