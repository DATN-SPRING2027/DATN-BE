import type { Connection, PipelineStage } from 'mongoose';
import { MongoUserDirectoryRepository } from './user-directory.repository';

it('scopes multi-word accent-insensitive search to active organization members and ranks before limiting', async () => {
  const pipelines: PipelineStage[][] = [];
  const connection = {
    models: {
      continuum_iam_users: {
        aggregate: (pipeline: PipelineStage[]) => {
          pipelines.push(pipeline);
          return { exec: () => Promise.resolve([]) };
        },
      },
    },
  } as unknown as Connection;
  const organizationId = '507f1f77bcf86cd799439001';
  const actorId = '507f1f77bcf86cd799439002';
  const repository = new MongoUserDirectoryRepository(connection);
  await repository.searchChatCandidates(
    organizationId,
    actorId,
    '  THANG   tran ',
  );
  expect(pipelines[0][0]).toHaveProperty('$search.index', 'chat_search_v1');
  expect(JSON.stringify(pipelines[0][0])).toContain('autocomplete');
  expect(JSON.stringify(pipelines[0])).not.toContain('$regex');
  const lookupIndex = pipelines[0].findIndex((stage) => '$lookup' in stage);
  expect(JSON.stringify(pipelines[0][lookupIndex])).toContain(organizationId);
  expect(JSON.stringify(pipelines[0][lookupIndex])).toContain('ACTIVE');
  const permissionIndex = pipelines[0].findIndex((stage) =>
    JSON.stringify(stage).includes('activeMembership.0'),
  );
  expect(permissionIndex).toBeLessThan(
    pipelines[0].findIndex((stage) => '$limit' in stage),
  );
  expect(JSON.stringify(pipelines[0].at(-1))).not.toContain('email');
});
it('uses the email index for literal address prefixes and keeps permission filtering before pagination', async () => {
  let pipeline: PipelineStage[] = [];
  const repository = new MongoUserDirectoryRepository({
    models: {
      continuum_iam_users: {
        aggregate: (value: PipelineStage[]) => {
          pipeline = value;
          return { exec: () => Promise.resolve([]) };
        },
      },
    },
  } as unknown as Connection);
  await repository.searchChatCandidates(
    '507f1f77bcf86cd799439001',
    '507f1f77bcf86cd799439002',
    'MEMBER@DATN',
  );
  expect(pipeline[0]).toEqual({
    $match: { email: { $gte: 'member@datn', $lt: 'member@dato' } },
  });
  expect(JSON.stringify(pipeline)).not.toMatch(/\$regex|\$search/);
  expect(
    pipeline.findIndex((stage) =>
      JSON.stringify(stage).includes('activeMembership.0'),
    ),
  ).toBeLessThan(pipeline.findIndex((stage) => '$limit' in stage));
});
