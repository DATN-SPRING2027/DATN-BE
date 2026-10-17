import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  planTeamFoundationRuntime,
  publicTeamFoundationRuntimeReport,
  TEAM_FOUNDATION_INDEXES,
} from './team-foundation-runtime.plan.mjs';
import { applyTeamFoundationRuntimePlan } from './20261015-team-foundation-runtime.mjs';

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
    targetFingerprint: 'synthetic-target-fingerprint',
    objects: {
      organizations: { type: 'collection', indexes: [] },
      projects: { type: 'collection', indexes: [] },
      teams: {
        type: 'collection',
        indexes: indexRows(teamIndexes),
      },
    },
    teams,
    organizations: [{ _id: org }],
    projects: [{ _id: project, organizationId: org }],
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

test('migration plans only the Team collection and scoped code index', () => {
  const snapshot = cleanSnapshot([], {
    objects: {
      organizations: { type: 'collection', indexes: [] },
      projects: { type: 'collection', indexes: [] },
    },
  });
  const plan = planTeamFoundationRuntime(snapshot);

  assert.equal(plan.clean, true);
  assert.deepEqual(plan.createCollections, [
    { database: 'continuum_iam', name: 'teams' },
  ]);
  assert.deepEqual(plan.indexesToCreate, [
    { collection: 'teams', ...TEAM_FOUNDATION_INDEXES.teams },
  ]);
  assert.doesNotMatch(
    JSON.stringify(plan),
    /team_operations|team_audit_command_dedupe/,
  );
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
    applyTeamFoundationRuntimePlan({ iamDb, plan }),
    /TEAM_CHANGED_AFTER_PREFLIGHT/,
  );
  assert.equal(updateCount, 0);
});

test('rejects parent mismatch, unsupported mapping fields, and Team index drift', () => {
  const wrongProject = new ObjectId();
  const snapshot = cleanSnapshot([baseTeam({ projectId: wrongProject })], {
    projects: [{ _id: project, organizationId: org }],
  });
  snapshot.objects.teams.indexes = [
    {
      key: { organizationId: 1, projectId: 1, code: 1 },
      name: TEAM_FOUNDATION_INDEXES.teams.name,
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

  const duplicateTeamCode = planTeamFoundationRuntime(
    cleanSnapshot([baseTeam(), baseTeam({ _id: new ObjectId() })]),
  );
  assert.ok(
    duplicateTeamCode.issues.some((issue) => issue.code === 'TEAM_CODE_COLLISION'),
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
