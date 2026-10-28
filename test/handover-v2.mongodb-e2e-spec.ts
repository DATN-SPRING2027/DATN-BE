import { createConnection, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createHandoverV2Schema } from '../src/services/handover/infrastructure/mongodb/handover-v2.schemas';

describe('Handover V2 Mongoose serialization on isolated MongoDB 7', () => {
  it('persists explicit nullable B, nested provenance, empty body, timestamps and canonical indexes', async () => {
    const server = await MongoMemoryServer.create({
      binary: { version: '7.0.24' },
    });
    const connection = createConnection(server.getUri(), {
      dbName: 'continuum_handover',
      autoCreate: false,
      autoIndex: false,
    });
    try {
      await connection.asPromise();
      const id = () => new Types.ObjectId();
      const scope = { organizationId: id(), projectId: id() };
      const Handovers = connection.model(
        'handover_v2_test',
        createHandoverV2Schema('handovers'),
      );
      const Items = connection.model(
        'handover_item_v2_test',
        createHandoverV2Schema('handover_items'),
      );
      expect(await connection.db!.listCollections().toArray()).toHaveLength(0);
      const handover = await Handovers.create({
        schemaVersion: 2,
        ...scope,
        departingUserId: id().toHexString(),
        assignedLeaderId: id().toHexString(),
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
        createdBy: id().toHexString(),
      });
      const source = {
        kind: 'PROJECT_DOCUMENT',
        id: 'document-1',
        version: 'v1',
      };
      await Items.create({
        schemaVersion: 2,
        ...scope,
        handoverId: handover._id,
        itemId: id(),
        contentVersion: 1,
        dependencyFingerprint: 'a'.repeat(64),
        title: 'Quy trình',
        body: '',
        requirement: 'Hiểu quy trình',
        isRequired: true,
        evidenceRequired: false,
        sources: [source],
        citations: [
          { source, locator: { kind: 'SECTION', value: 'Giới thiệu' } },
        ],
        updatedBy: id().toHexString(),
      });
      expect(
        await connection.collection('handovers').countDocuments({
          schemaVersion: 2,
          successorUserId: null,
          createdAt: { $type: 'date' },
          updatedAt: { $type: 'date' },
        }),
      ).toBe(1);
      expect(
        await connection.collection('handover_items').countDocuments({
          body: '',
          'sources.0.id': 'document-1',
          'citations.0.locator.value': 'Giới thiệu',
          'citations.0._id': { $exists: false },
          __v: { $exists: false },
        }),
      ).toBe(1);
      // Explicit sync only in this disposable DB; runtime automatic DDL stays disabled.
      await Handovers.createIndexes();
      expect(
        (await connection.collection('handovers').indexes()).some(
          (entry) => entry.name === 'handover_v2_open_unique',
        ),
      ).toBe(true);
    } finally {
      await connection.close();
      await server.stop();
    }
  }, 30_000);
});
