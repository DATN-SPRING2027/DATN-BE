import { model, Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

describe('organization_invitations persistence contract', () => {
  const definition = IAM_PERSISTENCE.collections.find(
    (collection) => collection.name === 'organization_invitations',
  );
  const schema = createCollectionSchema(definition!);
  const Invitation = model('OrganizationInvitationContractSpec', schema);

  it('uses one pending invitation per Organization and normalized email, with bounded inbox indexes', () => {
    expect(definition).toBeDefined();
    expect(schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { organizationId: 1, email: 1 },
          expect.objectContaining({
            name: 'uniq_pending_org_email',
            unique: true,
            partialFilterExpression: { status: 'PENDING' },
          }),
        ],
        [{ email: 1, status: 1, expiresAt: 1 }, expect.any(Object)],
        [{ organizationId: 1, status: 1, expiresAt: 1 }, expect.any(Object)],
      ]),
    );
    expect(
      schema.indexes().some(([, options]) => 'expireAfterSeconds' in options),
    ).toBe(false);
  });

  it('accepts invitation lifecycle metadata and rejects unsupported roles or states', () => {
    const base = {
      organizationId: new Types.ObjectId(),
      email: 'invitee@example.com',
      invitedBy: new Types.ObjectId(),
      expiresAt: new Date(Date.now() + 1000),
    };
    for (const status of ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']) {
      expect(
        new Invitation({ ...base, roleCode: 'MEMBER', status }).validateSync(),
      ).toBeUndefined();
    }
    expect(
      new Invitation({
        ...base,
        roleCode: 'PLATFORM_OPERATOR',
        status: 'PENDING',
      }).validateSync(),
    ).toBeDefined();
    expect(
      new Invitation({
        ...base,
        roleCode: 'MEMBER',
        status: 'ACTIVE',
      }).validateSync(),
    ).toBeDefined();
  });
});

describe('ACCOUNT refresh session persistence contract', () => {
  const definition = IAM_PERSISTENCE.collections.find(
    (collection) => collection.name === 'refresh_sessions',
  );
  const schema = createCollectionSchema(definition!);
  const Session = model('AccountRefreshSessionContractSpec', schema);

  it('allows ACCOUNT session context without an Organization id', () => {
    const session = new Session({
      userId: new Types.ObjectId(),
      context: 'ACCOUNT',
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(session.validateSync()).toBeUndefined();
    expect(session.organizationId).toBeUndefined();
  });
});
