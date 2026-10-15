import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  planTeamFoundationRuntime,
  publicTeamFoundationRuntimeReport,
  TEAM_FOUNDATION_INDEXES,
} from './team-foundation-runtime.plan.mjs';
import {
  applyTeamFoundationRuntimePlan,
  duplicateGroupPipeline,
} from './20261015-team-foundation-runtime.mjs';

const { ObjectId } = mongoose.mongo;
const org = new ObjectId();
const project = new ObjectId();
const actor = new ObjectId();
const team = new ObjectId();

function indexRows(definitions) {
  return definitions.map(({ key, ...options }) => ({ key, ...options }));
}

const baseTeam = (extra = {}) => ({
  _id: team,
  organizationId: org,
  projectId: project,
  name: 'Platform Team',
  code: 'PLATFORM',
  description: null,
  status: 'ACTIVE',
  version: 1,
  createdAt: new Date('2026-10-15T00:00:00Z'),
  updatedAt: new Date('2026-10-15T00:00:00Z'),
  archivedAt: null,
  archivedBy: null,
  archivedReason: null,
  ...extra,
});

function cleanSnapshot(teams = [baseTeam()], extra = {}) {
  const teamIndexes = [TEAM_FOUNDATION_INDEXES.teams];
  return {
    iamDatabaseName: 'continuum_iam',
    auditDatabaseName: 'continuum_audit',
    targetFingerprint: 'synthetic-target-fingerprint',
    objects: {
      organizations: { type: 'collection', indexes: [] },
      projects: { type: 'collection', indexes: [] },
      teams: {
        type: 'collection',
        indexes: indexRows(teamIndexes),
      },
      team_operations: {
        type: 'collection',
        indexes: indexRows(TEAM_FOUNDATION_INDEXES.teamOperations),
      },
    },
    auditObjects: {
      audit_logs_iam: {
        type: 'collection',
        indexes: indexRows([TEAM_FOUNDATION_INDEXES.audit]),
      },
    },
    teams,
    organizations: [{ _id: org }],
    projects: [{ _id: project, organizationId: org }],
    duplicateGroups: [],
    ...extra,
  };
}

test('clean metadata and required indexes plan no changes deterministically', () => {
  const snapshot = cleanSnapshot();
  const first = planTeamFoundationRuntime(snapshot);
  assert.equal(first.clean, true);
  assert.deepEqual(first.updates, []);
  assert.deepEqual(first.createCollections, []);
  assert.deepEqual(first.indexesToCreate, []);
  assert.deepEqual(planTeamFoundationRuntime(snapshot), first);
});

test('legacy metadata is never inferred and requires explicit per-Team mapping', () => {
  const legacy = baseTeam();
  for (const field of [
    'description',
    'status',
    'version',
    'archivedAt',
    'archivedBy',
    'archivedReason',
  ])
    delete legacy[field];

  const blocked = planTeamFoundationRuntime(cleanSnapshot([legacy]));
  assert.equal(blocked.clean, false);
  assert.deepEqual(blocked.updates, []);
  for (const field of [
    'description',
    'status',
    'version',
    'archivedAt',
    'archivedBy',
    'archivedReason',
  ])
    assert.ok(
      blocked.issues.some(
        (issue) => issue.id === team.toHexString() && issue.field === field,
      ),
    );

  const approvedMapping = {
    teams: [
      {
        id: team.toHexString(),
        set: {
          description: null,
          status: 'ACTIVE',
          version: 1,
          archivedAt: null,
          archivedBy: null,
          archivedReason: null,
        },
      },
    ],
  };
  const planned = planTeamFoundationRuntime(
    cleanSnapshot([legacy]),
    approvedMapping,
  );
  assert.equal(planned.clean, true);
  assert.equal(planned.updates.length, 1);
  assert.deepEqual(planned.updates[0].set, approvedMapping.teams[0].set);
  const publicReport = publicTeamFoundationRuntimeReport(planned);
  assert.doesNotMatch(JSON.stringify(publicReport), /Platform Team|PLATFORM/);
  assert.doesNotMatch(JSON.stringify(publicReport), /"set"/);
});

test('canonical values are mapped explicitly and collisions include archived Teams', () => {
  const secondTeam = new ObjectId();
  const first = baseTeam({ code: ' legacy ' });
  const archived = baseTeam({
    _id: secondTeam,
    status: 'ARCHIVED',
    archivedAt: new Date('2026-10-14T00:00:00Z'),
    archivedBy: actor,
    archivedReason: 'Retained',
  });
  const snapshot = cleanSnapshot([first, archived]);
  const mapping = {
    teams: [{ id: team.toHexString(), set: { code: 'PLATFORM' } }],
  };
  const plan = planTeamFoundationRuntime(snapshot, mapping);
  assert.equal(plan.clean, false);
  assert.ok(plan.issues.some((issue) => issue.code === 'TEAM_CODE_COLLISION'));
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].set.code, 'PLATFORM');
});

test('CAS rejects an explicitly-null field changed after preflight', async () => {
  const original = baseTeam({ name: 'Legacy Team' });
  const plan = planTeamFoundationRuntime(cleanSnapshot([original]), {
    teams: [{ id: team.toHexString(), set: { name: 'New Team Name' } }],
  });
  assert.equal(plan.clean, true);
  assert.equal(plan.updates.length, 1);

  let updateCount = 0;
  const collection = {
    findOne: async () => ({
      ...original,
      archivedAt: new Date('2026-10-15T00:00:00Z'),
    }),
    updateOne: async () => {
      updateCount += 1;
      return { matchedCount: 1 };
    },
  };
  const iamDb = { collection: () => collection };

  await assert.rejects(
    applyTeamFoundationRuntimePlan({ iamDb, auditDb: {}, plan }),
    /TEAM_CHANGED_AFTER_PREFLIGHT/,
  );
  assert.equal(updateCount, 0);
});

test('rejects parent mismatch, unsupported mapping fields, index drift and duplicate scopes', () => {
  const wrongProject = new ObjectId();
  const snapshot = cleanSnapshot([baseTeam({ projectId: wrongProject })], {
    projects: [{ _id: project, organizationId: org }],
    duplicateGroups: [
      {
        collection: 'team_operations',
        index: 'team_operation_scope',
        count: 2,
      },
    ],
  });
  snapshot.objects.team_operations.indexes = [
    {
      key: { organizationId: 1, actorUserId: 1, keyHash: 1 },
      name: 'team_operation_scope',
      unique: false,
    },
  ];
  const plan = planTeamFoundationRuntime(snapshot, {
    teams: [{ id: team.toHexString(), set: { projectId: wrongProject } }],
  });
  assert.equal(plan.clean, false);
  assert.ok(
    plan.issues.some((issue) => issue.code === 'PARENT_MISSING_OR_MISMATCHED'),
  );
  assert.ok(
    plan.issues.some((issue) => issue.code === 'INVALID_MAPPING_FIELD'),
  );
  assert.ok(
    plan.issues.some((issue) => issue.code === 'INDEX_OPTIONS_CONFLICT'),
  );
  assert.ok(
    plan.issues.some((issue) => issue.code === 'UNIQUE_INDEX_DUPLICATES'),
  );

  const topLevelExtra = planTeamFoundationRuntime(cleanSnapshot(), {
    teams: [],
    inferredDefaults: true,
  });
  assert.ok(
    topLevelExtra.issues.some((issue) => issue.code === 'INVALID_MAPPING_FILE'),
  );
  const rowExtra = planTeamFoundationRuntime(cleanSnapshot(), {
    teams: [{ id: team.toHexString(), set: {}, note: 'ignored is unsafe' }],
  });
  assert.ok(
    rowExtra.issues.some((issue) => issue.code === 'INVALID_MAPPING_ENTRY'),
  );
});

test('refuses an unexpected logical database before making a plan', () => {
  assert.throws(
    () =>
      planTeamFoundationRuntime(
        cleanSnapshot([], { iamDatabaseName: 'continuum_db' }),
      ),
    /IAM_TARGET_REQUIRED/,
  );
});

test('audit duplicate preflight aliases dotted fields in its aggregation key', () => {
  const pipeline = duplicateGroupPipeline(
    { targetResource: 'Team' },
    {
      organizationId: 1,
      'metadata.commandId': 1,
      action: 1,
      targetResourceId: 1,
    },
  );
  assert.deepEqual(pipeline[1].$group._id, {
    field0: { $ifNull: ['$organizationId', null] },
    field1: { $ifNull: ['$metadata.commandId', null] },
    field2: { $ifNull: ['$action', null] },
    field3: { $ifNull: ['$targetResourceId', null] },
  });
});
