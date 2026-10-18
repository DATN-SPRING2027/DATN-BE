import type { Connection } from 'mongoose';
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- MongoDB aggregation mock models an untyped driver result. */
import { SERVICE_DATABASES } from '../../../common/mongodb/database-names';
import { MongoPlatformIntegrationReadRepository } from './platform-integration-read.repository';

describe('MongoPlatformIntegrationReadRepository', () => {
  it('projects Jira connection and failed sync metadata without credential fields or raw errors', async () => {
    const connectionId = 'a'.repeat(24);
    const organizationId = 'b'.repeat(24);
    const projectId = 'c'.repeat(24);
    const failedAt = new Date('2026-10-17T00:00:00.000Z');
    const row = {
      _id: { toString: () => connectionId },
      organizationId: { toString: () => organizationId },
      projectId: { toString: () => projectId },
      status: 'CONNECTED',
      lastSyncAt: new Date('2026-10-16T00:00:00.000Z'),
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-17T00:00:00.000Z'),
      credentialsEncrypted: 'encrypted-secret-sentinel',
      webhookSecret: 'webhook-secret-sentinel',
      atlassianUrl: 'https://tenant.atlassian.net',
    };
    const connectionCursor = {
      sort: jest.fn(),
      skip: jest.fn(),
      limit: jest.fn(),
      toArray: jest.fn().mockResolvedValue([row]),
    };
    connectionCursor.sort.mockReturnValue(connectionCursor);
    connectionCursor.skip.mockReturnValue(connectionCursor);
    connectionCursor.limit.mockReturnValue(connectionCursor);
    const failureCursor = {
      toArray: jest.fn().mockResolvedValue([{ _id: row._id, failedAt }]),
    };
    const connections = {
      find: jest.fn().mockReturnValue(connectionCursor),
      countDocuments: jest.fn().mockResolvedValue(1),
    };
    const syncJobs = {
      aggregate: jest.fn().mockReturnValue(failureCursor),
    };
    const database = {
      collection: jest.fn((name: string) =>
        name === 'jira_connections' ? connections : syncJobs,
      ),
    };
    const useDb = jest.fn().mockReturnValue(database);
    const repository = new MongoPlatformIntegrationReadRepository({
      useDb,
    } as unknown as Connection);

    const page = await repository.list({ page: 1, pageSize: 20 });

    expect(useDb).toHaveBeenCalledWith(SERVICE_DATABASES.jira, {
      useCache: true,
    });
    expect(page).toMatchObject({
      data: [
        {
          id: connectionId,
          provider: 'JIRA',
          organizationId,
          projectId,
          status: 'CONNECTED',
          lastFailureAt: failedAt.toISOString(),
          lastFailureSummary:
            'A Jira sync failed. Raw failure details are withheld.',
        },
      ],
      pagination: { totalItems: 1, totalPages: 1 },
    });
    expect(connections.find).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        projection: expect.not.objectContaining({
          credentialsEncrypted: 1,
          webhookSecret: 1,
          atlassianUrl: 1,
        }),
      }),
    );
    expect(JSON.stringify(page)).not.toMatch(
      /encrypted-secret-sentinel|webhook-secret-sentinel|tenant\.atlassian\.net|raw errors/i,
    );
  });
});
