import mongoose, { Types } from 'mongoose';
import { createCollectionSchema } from './mongodb.schemas';

const Team = mongoose.model(
  'TeamFoundationSchemaTest',
  createCollectionSchema({ name: 'teams' }),
);
const input = () => ({
  organizationId: new Types.ObjectId(),
  projectId: new Types.ObjectId(),
  name: 'Example',
  code: 'EX',
  description: null,
  status: 'ACTIVE',
  version: 1,
  archivedAt: null,
  archivedBy: null,
  archivedReason: null,
});

describe('selected Team metadata contract (DATN-254)', () => {
  afterAll(() => mongoose.deleteModel('TeamFoundationSchemaTest'));

  it('normalizes new name/code and retains description whitespace', () => {
    const team = new Team({
      ...input(),
      name: ' e\u0301 ',
      code: ' ex ',
      description: ' a\n\tb ',
    });
    expect(team.name).toBe('é');
    expect(team.code).toBe('EX');
    expect(team.description).toBe(' a\n\tb ');
    expect(team.validateSync()).toBeUndefined();
  });

  it.each(['', ' ', 'a\u0000b', 'a\u007fb', 'x'.repeat(201)])(
    'rejects invalid name %j',
    (name) => {
      expect(
        new Team({ ...input(), name }).validateSync()?.errors.name,
      ).toBeDefined();
    },
  );
  it('counts Unicode code points rather than UTF-16 units', () => {
    expect(
      new Team({ ...input(), name: '😀'.repeat(200) }).validateSync(),
    ).toBeUndefined();
    expect(
      new Team({ ...input(), description: '😀'.repeat(2000) }).validateSync(),
    ).toBeUndefined();
    expect(
      new Team({ ...input(), description: '😀'.repeat(2001) }).validateSync()
        ?.errors.description,
    ).toBeDefined();
  });
  it('accepts an explicitly empty or null description but still requires the field', () => {
    expect(
      new Team({ ...input(), description: '' }).validateSync(),
    ).toBeUndefined();
    expect(
      new Team({ ...input(), description: null }).validateSync(),
    ).toBeUndefined();
    const missing: Record<string, unknown> = input();
    delete missing.description;
    expect(new Team(missing).validateSync()?.errors.description).toBeDefined();
  });
  it.each(['A', '1A', 'A B', 'ÁB', 'AB!', 'ſB'])(
    'rejects invalid code %j',
    (code) => {
      expect(
        new Team({ ...input(), code }).validateSync()?.errors.code,
      ).toBeDefined();
    },
  );
  it.each(['a\u0000b', 'a\u007fb', 'a\u000bb'])(
    'rejects description controls %j',
    (description) => {
      expect(
        new Team({ ...input(), description }).validateSync()?.errors
          .description,
      ).toBeDefined();
    },
  );
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', true])(
    'rejects version %s',
    (version) => {
      expect(
        new Team({ ...input(), version }).validateSync()?.errors.version,
      ).toBeDefined();
    },
  );
  it('does not grant lifecycle/version to legacy records on hydration', () => {
    const team = Team.hydrate({
      _id: new Types.ObjectId(),
      organizationId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      name: 'Legacy',
      code: 'LG',
    });
    expect(team.status).toBeUndefined();
    expect(team.version).toBeUndefined();
    expect(team.validateSync()?.errors.status).toBeDefined();
    expect(team.validateSync()?.errors.version).toBeDefined();
  });
  it.each([' e\u0301 ', '   '])(
    'preserves but rejects noncanonical hydrated name %j',
    (name) => {
      const team = Team.hydrate({ ...input(), name });
      expect(team.name).toBe(name);
      expect(team.validateSync()?.errors.name).toBeDefined();
    },
  );
  it('preserves but rejects noncanonical hydrated code', () => {
    const team = Team.hydrate({ ...input(), code: ' ex ' });
    expect(team.name).toBe('Example');
    expect(team.code).toBe(' ex ');
    expect(team.validateSync()?.errors.code).toBeDefined();
  });
  it.each(['description', 'archivedAt', 'archivedBy', 'archivedReason'])(
    'requires an explicit nullable %s in persisted metadata',
    (field) => {
      const row: Record<string, unknown> = input();
      delete row[field];
      expect(new Team(row).validateSync()?.errors[field]).toBeDefined();
    },
  );
  it('requires archive evidence and rejects active archive metadata', () => {
    const missing = new Team({ ...input(), status: 'ARCHIVED' });
    expect(missing.validateSync()?.errors.archivedAt).toBeDefined();
    expect(missing.validateSync()?.errors.archivedBy).toBeDefined();
    expect(missing.validateSync()?.errors.archivedReason).toBeDefined();
    expect(
      new Team({
        ...input(),
        status: 'ARCHIVED',
        archivedAt: new Date(),
        archivedBy: new Types.ObjectId(),
        archivedReason: 'Approved archive',
      }).validateSync(),
    ).toBeUndefined();
    expect(
      new Team({ ...input(), archivedAt: new Date() }).validateSync()?.errors
        .archivedAt,
    ).toBeDefined();
  });
  it('rejects unsupported lifecycle and fields from deferred work', () => {
    expect(
      new Team({ ...input(), status: 'DELETED' }).validateSync()?.errors.status,
    ).toBeDefined();
    expect(() => new Team({ ...input(), teamAccessGeneration: 1 })).toThrow();
  });
  it('preserves parent/code on an existing record', () => {
    const row = { ...input(), _id: new Types.ObjectId() };
    const team = Team.hydrate(row);
    team.organizationId = new Types.ObjectId();
    team.projectId = new Types.ObjectId();
    team.code = 'OTHER';
    expect(team.organizationId).toEqual(row.organizationId);
    expect(team.projectId).toEqual(row.projectId);
    expect(team.code).toBe(row.code);
  });
});
