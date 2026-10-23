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
  expect(JSON.stringify(pipelines[0].at(-1))).toContain('email');
});
it('lists active organization members sorted by name when search is empty and falls back when $search is unavailable', async () => {
  const pipelines: PipelineStage[][] = [];
  let callCount = 0;
  const connection = {
    models: {
      continuum_iam_users: {
        aggregate: (pipeline: PipelineStage[]) => {
          pipelines.push(pipeline);
          callCount += 1;
          if (callCount === 2) {
            return {
              exec: () =>
                Promise.reject(new Error('$search not enabled on local mongo')),
            };
          }
          return {
            exec: () =>
              Promise.resolve([
                {
                  id: '507f1f77bcf86cd799439003',
                  fullName: 'Trần Kim Thắng',
                  email: 'thang@datn.edu.vn',
                  avatarUrl: null,
                },
              ]),
          };
        },
      },
    },
  } as unknown as Connection;
  const organizationId = '507f1f77bcf86cd799439001';
  const actorId = '507f1f77bcf86cd799439002';
  const repository = new MongoUserDirectoryRepository(connection);
  const initialList = await repository.searchChatCandidates(
    organizationId,
    actorId,
    '',
  );
  expect(initialList).toHaveLength(1);
  expect(JSON.stringify(pipelines[0])).not.toContain('$search');
  expect(JSON.stringify(pipelines[0])).toContain('activeMembership.0');

  const fallbackList = await repository.searchChatCandidates(
    organizationId,
    actorId,
    'thang tran',
  );
  expect(fallbackList).toHaveLength(1);
  expect(fallbackList[0].email).toBe('thang@datn.edu.vn');

  const singleCharList = await repository.searchChatCandidates(
    organizationId,
    actorId,
    't',
  );
  expect(singleCharList).toHaveLength(1);
  expect(JSON.stringify(pipelines.at(-1))).not.toContain('$search');
});
it('starts from organization_memberships when listing candidates without a search term', async () => {
  let membershipPipeline: PipelineStage[] = [];
  const repository = new MongoUserDirectoryRepository({
    models: {
      continuum_iam_organization_memberships: {
        aggregate: (value: PipelineStage[]) => {
          membershipPipeline = value;
          return {
            exec: () =>
              Promise.resolve([
                {
                  id: '507f1f77bcf86cd799439003',
                  fullName: 'Member One',
                  email: 'one@datn.edu.vn',
                  avatarUrl: null,
                },
              ]),
          };
        },
      },
    },
  } as unknown as Connection);
  const result = await repository.searchChatCandidates(
    '507f1f77bcf86cd799439001',
    '507f1f77bcf86cd799439002',
    '',
  );
  expect(result).toHaveLength(1);
  expect(JSON.stringify(membershipPipeline[0])).toContain(
    '507f1f77bcf86cd799439001',
  );
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
