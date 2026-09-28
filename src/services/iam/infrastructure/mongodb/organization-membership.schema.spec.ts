import { model, Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

describe('organization_memberships persistence contract', () => {
  const definition = IAM_PERSISTENCE.collections.find(
    (collection) => collection.name === 'organization_memberships',
  );
  const schema = createCollectionSchema(definition!);
  const Membership = model('OrganizationMembershipContractSpec', schema);

  it('owns a User to Organization relation with one record per pair', () => {
    expect(definition).toBeDefined();
    expect(schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { organizationId: 1, userId: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [{ userId: 1, status: 1, organizationId: 1 }, expect.any(Object)],
      ]),
    );
    expect(Object.keys(schema.indexes()[1][0])).toEqual([
      'userId',
      'status',
      'organizationId',
    ]);

    expect(schema.path('organizationId')).toBeDefined();
    expect(schema.path('userId')).toBeDefined();
    expect(schema.path('roleCode')).toBeUndefined();
  });

  it('accepts only the four decided Organization Membership states', () => {
    const membership = {
      organizationId: new Types.ObjectId(),
      userId: new Types.ObjectId(),
    };

    for (const status of ['PENDING_INVITE', 'ACTIVE', 'SUSPENDED', 'REMOVED']) {
      const document = new Membership({ ...membership, status });
      expect(document.validateSync()).toBeUndefined();
    }

    const invalid = new Membership({ ...membership, status: 'ONBOARDING' });
    expect(invalid.validateSync()).toBeDefined();
  });
});
