import type { ProjectRepository } from './project.repository';
import { ProjectService } from './project.service';

const actor = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  organizationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  email: 'member@example.test',
  name: 'Member',
  roles: ['MEMBER'],
};

function fixture(listVisible: jest.Mock) {
  const repository = { listVisible } as unknown as ProjectRepository;
  return new ProjectService(repository);
}

describe('ProjectService list pagination', () => {
  it('preserves total pagination when requested', async () => {
    const listVisible = jest
      .fn()
      .mockResolvedValue({ data: [], totalItems: 25 });
    const service = fixture(listVisible);

    await expect(
      service.list(actor, { page: 2, pageSize: 10, includeTotal: true }),
    ).resolves.toEqual({
      data: [],
      pagination: { page: 2, pageSize: 10, totalItems: 25, totalPages: 3 },
    });
  });

  it('returns lookahead pagination without total fields when not requested', async () => {
    const listVisible = jest
      .fn()
      .mockResolvedValue({ data: [], hasMore: true });
    const service = fixture(listVisible);

    await expect(
      service.list(actor, { page: 1, pageSize: 20, includeTotal: false }),
    ).resolves.toEqual({
      data: [],
      pagination: { page: 1, pageSize: 20, hasMore: true },
    });
  });
});
