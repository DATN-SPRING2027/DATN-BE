import { Mongoose, Types } from 'mongoose';
import { createHandoverV2Schema } from './handover-v2.schemas';
import { createCollectionSchema } from './mongodb.schemas';
import { HANDOVER_PERSISTENCE } from '../persistence';

describe('Handover V2 database contract', () => {
  const mongoose = new Mongoose();
  const id = () => new Types.ObjectId();
  const user = () => id().toHexString();
  const handover = () => ({
    schemaVersion: 2,
    organizationId: id(),
    projectId: id(),
    departingUserId: user(),
    assignedLeaderId: user(),
    successorUserId: null,
    title: 'Bàn giao',
    targetCompletionDate: new Date(),
    status: 'OPEN',
    version: 1,
    draftVersion: 0,
    assignmentVersion: 0,
    publishedRevisionId: null,
    selectedSources: [],
    selectedTasks: [],
    createdBy: user(),
  });
  const model = (collection: string) =>
    mongoose.model(`test_${collection}`, createHandoverV2Schema(collection));
  const Handovers = model('handovers');

  it('allows no B, without silently promoting a legacy document to V2', async () => {
    await expect(new Handovers(handover()).validate()).resolves.toBeUndefined();
    const legacy = createCollectionSchema({ name: 'handovers' });
    expect(legacy.path('schemaVersion')).toBeUndefined();
    const document = new Handovers(handover());
    document.set('schemaVersion', undefined);
    await expect(document.validate()).rejects.toThrow();
  });

  it('rejects multiple recipients, fractional epochs and unknown fields', async () => {
    await expect(
      new Handovers({
        ...handover(),
        successorUserId: [user(), user()],
      }).validate(),
    ).rejects.toThrow();
    await expect(
      new Handovers({ ...handover(), assignmentVersion: 0.5 }).validate(),
    ).rejects.toThrow();
    expect(() => new Handovers({ ...handover(), isResolved: true })).toThrow();
  });

  it('has no TTL for durable operations and scopes unique OPEN handovers to V2', () => {
    const definitions = new Map(
      HANDOVER_PERSISTENCE.collections.map((c) => [c.name, c]),
    );
    const indexes = definitions.get('handovers')!.indexes!;
    const activeUnique = indexes.find(
      (entry) => entry.options?.name === 'handover_v2_open_unique',
    );
    expect(activeUnique?.fields).toEqual({
      organizationId: 1,
      projectId: 1,
      departingUserId: 1,
    });
    expect(activeUnique?.options?.unique).toBe(true);
    expect(activeUnique?.options?.partialFilterExpression).toEqual({
      schemaVersion: 2,
      status: 'OPEN',
    });
    expect(
      definitions
        .get('handover_operations')!
        .indexes!.every((i) => i.options?.expireAfterSeconds === undefined),
    ).toBe(true);
  });

  it('binds acknowledgements to recipient, assignment epoch, revision and item content', async () => {
    const Acceptances = model('handover_acceptances');
    const acceptance = {
      schemaVersion: 2,
      organizationId: id(),
      projectId: id(),
      handoverId: id(),
      revisionId: id(),
      successorUserId: user(),
      assignmentVersion: 3,
      kind: 'ITEM',
      itemId: id(),
      contentVersion: 2,
      dependencyFingerprint: 'a'.repeat(64),
      decision: 'UNDERSTOOD',
      note: '',
      commandId: id(),
      sequence: 1,
      occurredAt: new Date(),
    };
    await expect(
      new Acceptances(acceptance).validate(),
    ).resolves.toBeUndefined();
    await expect(
      new Acceptances({
        ...acceptance,
        assignmentVersion: undefined,
      }).validate(),
    ).rejects.toThrow();
  });

  it('stores a knowledge gap without legacy milestone or successor requirements', async () => {
    const FollowUps = model('follow_up_tasks');
    await expect(
      new FollowUps({
        schemaVersion: 2,
        organizationId: id(),
        projectId: id(),
        handoverId: id(),
        revisionId: id(),
        itemId: id(),
        kind: 'KNOWLEDGE_GAP',
        isRequired: false,
        ownerUserId: user(),
        reason: 'Cần bổ sung',
        dueAt: new Date(),
        status: 'OPEN',
        version: 1,
        createdBy: user(),
        resolvedAt: null,
      }).validate(),
    ).resolves.toBeUndefined();
  });
});
