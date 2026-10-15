import mongoose, { Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

const Team = mongoose.model(
  'Datn254TeamFoundationSchemaSpec',
  createCollectionSchema(
    IAM_PERSISTENCE.collections.find(({ name }) => name === 'teams')!,
  ),
);

const teamInput = (overrides: Record<string, unknown> = {}) => ({
  organizationId: new Types.ObjectId(),
  projectId: new Types.ObjectId(),
  name: 'Platform Team',
  code: 'PLATFORM_1',
  description: null,
  status: 'ACTIVE',
  version: 1,
  archivedAt: null,
  archivedBy: null,
  archivedReason: null,
  ...overrides,
});

describe('DATN-254 Team foundation schema', () => {
  afterAll(() => {
    mongoose.deleteModel('Datn254TeamFoundationSchemaSpec');
  });

  it.each([null, ''])(
    'accepts a present nullable or empty description (%s)',
    async (description) => {
      const team = new Team(teamInput({ description }));

      expect(team.validateSync()).toBeUndefined();
      await expect(team.validate()).resolves.toBeUndefined();
    },
  );

  it('rejects a missing description without silently normalizing the name or code', async () => {
    const team = new Team(
      teamInput({
        description: undefined,
        name: '  Platform Team  ',
        code: ' platform_1 ',
      }),
    );

    expect(team.name).toBe('  Platform Team  ');
    expect(team.code).toBe(' platform_1 ');
    expect(team.validateSync()?.errors.description).toBeDefined();
    await expect(team.validate()).rejects.toHaveProperty('errors.description');
    await expect(team.validate()).rejects.toHaveProperty('errors.name');
    await expect(team.validate()).rejects.toHaveProperty('errors.code');
  });

  it.each(['x'.repeat(2001), '\u0001'])(
    'rejects invalid Team description %j',
    async (description) => {
      const team = new Team(teamInput({ description }));

      await expect(team.validate()).rejects.toHaveProperty(
        'errors.description',
      );
      expect(team.description).toBe(description);
    },
  );

  it.each(['  Platform Team  ', 'Platform Team\u0301', 'Team\nName'])(
    'rejects noncanonical Team name %j',
    async (name) => {
      const team = new Team(teamInput({ name }));

      await expect(team.validate()).rejects.toHaveProperty('errors.name');
      expect(team.name).toBe(name);
    },
  );

  it.each(['a', 'lower_1', 'TEAM$', 'T'.repeat(33)])(
    'rejects noncanonical Team code %j without normalizing it',
    async (code) => {
      const team = new Team(teamInput({ code }));

      await expect(team.validate()).rejects.toHaveProperty('errors.code');
      expect(team.code).toBe(code);
    },
  );

  it('requires an explicit safe version and lifecycle profile', async () => {
    const missingProfile = new Team(
      teamInput({ status: undefined, version: undefined }),
    );
    const unsafeVersion = new Team(teamInput({ version: 1.5 }));

    await expect(missingProfile.validate()).rejects.toHaveProperty(
      'errors.status',
    );
    await expect(missingProfile.validate()).rejects.toHaveProperty(
      'errors.version',
    );
    await expect(unsafeVersion.validate()).rejects.toHaveProperty(
      'errors.version',
    );
  });

  it('accepts complete archive metadata and rejects partial or active archive metadata', async () => {
    const archived = new Team(
      teamInput({
        status: 'ARCHIVED',
        archivedAt: new Date('2026-10-14T00:00:00.000Z'),
        archivedBy: new Types.ObjectId(),
        archivedReason: 'Project concluded',
      }),
    );
    const partialArchive = new Team(
      teamInput({ status: 'ARCHIVED', archivedAt: new Date() }),
    );
    const activeWithArchive = new Team(
      teamInput({ archivedReason: 'Unexpected value' }),
    );

    await expect(archived.validate()).resolves.toBeUndefined();
    await expect(partialArchive.validate()).rejects.toHaveProperty(
      'errors.archivedBy',
    );
    await expect(activeWithArchive.validate()).rejects.toHaveProperty(
      'errors.archivedReason',
    );
  });

  it('requires explicit null archive metadata for active Teams', async () => {
    const missingArchiveMetadata = new Team(
      teamInput({
        archivedAt: undefined,
        archivedBy: undefined,
        archivedReason: undefined,
      }),
    );

    await expect(missingArchiveMetadata.validate()).rejects.toHaveProperty(
      'errors.archivedAt',
    );
    await expect(missingArchiveMetadata.validate()).rejects.toHaveProperty(
      'errors.archivedBy',
    );
    await expect(missingArchiveMetadata.validate()).rejects.toHaveProperty(
      'errors.archivedReason',
    );
  });

  it.each(['', '  ', 'Archived\nreason', 'x'.repeat(501)])(
    'rejects a noncanonical archived reason %j',
    async (archivedReason) => {
      const archived = new Team(
        teamInput({
          status: 'ARCHIVED',
          archivedAt: new Date('2026-10-14T00:00:00.000Z'),
          archivedBy: new Types.ObjectId(),
          archivedReason,
        }),
      );

      await expect(archived.validate()).rejects.toHaveProperty(
        'errors.archivedReason',
      );
    },
  );

  it('preserves noncanonical legacy values when hydrating and reports them on validation', async () => {
    const raw = {
      _id: new Types.ObjectId(),
      organizationId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      name: '  Platform Team  ',
      code: ' platform_1 ',
      description: '',
      status: 'ACTIVE',
      version: 1,
      archivedAt: null,
      archivedBy: null,
      archivedReason: null,
    };
    const team = Team.hydrate(raw);

    expect(team.name).toBe(raw.name);
    expect(team.code).toBe(raw.code);
    await expect(team.validate()).rejects.toHaveProperty('errors.name');
    await expect(team.validate()).rejects.toHaveProperty('errors.code');
  });

  it('keeps organization, project, and code immutable after creation', () => {
    const id = new Types.ObjectId();
    const original = teamInput();
    const team = Team.hydrate({ _id: id, ...original });
    const nextOrganizationId = new Types.ObjectId();
    const nextProjectId = new Types.ObjectId();

    team.organizationId = nextOrganizationId;
    team.projectId = nextProjectId;
    team.code = 'MOVED_TEAM';

    expect(team.organizationId).toEqual(original.organizationId);
    expect(team.projectId).toEqual(original.projectId);
    expect(team.code).toBe(original.code);
    expect(team.modifiedPaths()).toEqual([]);

    for (const path of ['organizationId', 'projectId', 'code']) {
      expect(Team.schema.path(path).options.immutable).toBe(true);
    }

    const query = Team.updateOne(
      { _id: id },
      {
        $set: {
          organizationId: nextOrganizationId,
          projectId: nextProjectId,
          code: 'MOVED_TEAM',
          name: 'Renamed Team',
        },
      },
    );
    const castUpdate = (
      query as unknown as { _castUpdate: (update: unknown) => unknown }
    )._castUpdate(query.getUpdate());

    expect(castUpdate).toEqual({ $set: { name: 'Renamed Team' } });
  });

  it('keeps the existing scoped unique code index without adding speculative indexes', () => {
    expect(Team.schema.indexes()).toEqual([
      [
        { organizationId: 1, projectId: 1, code: 1 },
        { unique: true, background: true },
      ],
    ]);
  });
});
