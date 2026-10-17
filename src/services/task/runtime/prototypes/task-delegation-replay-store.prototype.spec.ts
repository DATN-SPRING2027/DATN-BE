import type { Connection } from 'mongoose';
import type { TaskDelegationReplayEvidence } from './task-delegation-assertion.prototype';
import { MongoTaskDelegationReplayStore } from './task-delegation-replay-store.prototype';

describe('MongoTaskDelegationReplayStore write durability', () => {
  it('requires majority acknowledgement before accepting a replay marker', async () => {
    const collection = {
      createIndex: jest.fn().mockResolvedValue('index'),
      insertOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    const connection = {
      db: { collection: jest.fn(() => collection) },
    } as unknown as Connection;
    const store = await MongoTaskDelegationReplayStore.create(connection);
    const evidence: TaskDelegationReplayEvidence = {
      issuer: 'urn:datn:iam',
      tokenId: 'replay-marker',
      retainUntil: new Date(Date.now() + 60_000),
    };

    await expect(store.consume(evidence)).resolves.toBe(true);

    expect(collection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        issuer: evidence.issuer,
        tokenId: evidence.tokenId,
        retainUntil: evidence.retainUntil,
      }),
      { writeConcern: { w: 'majority' } },
    );
  });
});
