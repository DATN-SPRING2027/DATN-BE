import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { planTeamFoundation } from './team-foundation.plan.mjs';

const { ObjectId } = mongoose.mongo;
const org = new ObjectId(),
  project = new ObjectId(),
  actor = new ObjectId();
const row = (extra = {}) => ({
  _id: new ObjectId(),
  organizationId: org,
  projectId: project,
  name: 'Example',
  code: 'EX',
  description: null,
  status: 'ACTIVE',
  version: 1,
  createdAt: new Date('2026-10-14T00:00:00Z'),
  updatedAt: new Date('2026-10-14T00:00:00Z'),
  archivedAt: null,
  archivedBy: null,
  archivedReason: null,
  ...extra,
});
const snapshot = (teams = [row()], extra = {}) => ({
  databaseName: 'continuum_iam',
  targetFingerprint: 'synthetic-target',
  teams,
  organizations: [{ _id: org }],
  projects: [{ _id: project, organizationId: org }],
  objects: {
    teams: {
      type: 'collection',
      options: {},
      indexes: [
        {
          key: { organizationId: 1, projectId: 1, code: 1 },
          name: 'organizationId_1_projectId_1_code_1',
          unique: true,
        },
      ],
    },
    organizations: { type: 'collection' },
    projects: { type: 'collection' },
  },
  ...extra,
});

test('clean metadata produces a deterministic read-only report', () => {
  const input = snapshot();
  const before = mongoose.mongo.BSON.EJSON.stringify(input);
  const report = planTeamFoundation(input);
  assert.equal(report.clean, true);
  assert.deepEqual(report.assessmentBasis, {
    source: 'DATN-89 proposed Team decision table',
    asOf: '2026-10-14',
    decisionStatus: 'PROPOSED',
    authoritySignoff: 'PENDING',
    proposedDispositions: {
      'TQ-01': 'APPROVE',
      'TQ-02': 'APPROVE',
      'TQ-03': 'APPROVE',
      'TQ-04': 'APPROVE',
      'TQ-05': 'AMEND',
      'TQ-06': 'AMEND',
      'TQ-07': 'AMEND',
      'TQ-08': 'AMEND',
      'TQ-09': { contract: 'APPROVE', mutations: 'DEFER' },
      'TQ-10': 'DEFER',
    },
    runtimeSchemaEnforced: false,
    rolloutReady: false,
  });
  assert.equal(report.applySupported, false);
  assert.deepEqual(report.proposedDocumentWrites, []);
  assert.equal(mongoose.mongo.BSON.EJSON.stringify(input), before);
  assert.deepEqual(planTeamFoundation(input), report);
});
test('legacy status/version/nullable metadata require explicit mapping, without defaults', () => {
  const legacy = row();
  for (const field of [
    'status',
    'version',
    'description',
    'archivedAt',
    'archivedBy',
    'archivedReason',
  ])
    delete legacy[field];
  const report = planTeamFoundation(snapshot([legacy]));
  assert.equal(report.clean, false);
  for (const field of [
    'status',
    'version',
    'description',
    'archivedAt',
    'archivedBy',
    'archivedReason',
  ])
    assert.ok(report.issues.some((issue) => issue.field === field));
  assert.deepEqual(report.proposedDocumentWrites, []);
});
test('rejects noncanonical name/code, controls and bounds without rewriting', () => {
  for (const extra of [
    { name: ' e\u0301 ' },
    { code: ' ex ' },
    { code: 'ſB' },
    { name: 'x\u0000' },
    { name: '😀'.repeat(201) },
    { description: '\u000b' },
    { description: '😀'.repeat(2001) },
  ]) {
    assert.equal(planTeamFoundation(snapshot([row(extra)])).clean, false);
  }
  assert.equal(
    planTeamFoundation(
      snapshot([row({ name: '😀'.repeat(200), description: ' \n\t' })]),
    ).clean,
    true,
  );
  assert.equal(
    planTeamFoundation(snapshot([row({ description: '' })])).clean,
    true,
  );
});
test('reports raw and normalized code collisions across retained lifecycle states', () => {
  const archived = row({
    status: 'ARCHIVED',
    archivedAt: new Date(),
    archivedBy: actor,
    archivedReason: 'Archive',
  });
  for (const code of ['EX', ' ex ']) {
    const report = planTeamFoundation(snapshot([row(), { ...archived, code }]));
    assert.ok(report.issues.some((issue) => issue.code === 'CODE_COLLISION'));
  }
  const otherProject = new ObjectId();
  const input = snapshot([row(), row({ projectId: otherProject })]);
  input.projects.push({ _id: otherProject, organizationId: org });
  assert.equal(planTeamFoundation(input).clean, true);
});
test('denies missing, malformed and mismatched parent references', () => {
  for (const extra of [
    { projects: [] },
    { organizations: [] },
    { projects: [{ _id: project, organizationId: new ObjectId() }] },
    { teams: [row({ projectId: project.toHexString() })] },
  ]) {
    assert.equal(planTeamFoundation(snapshot(undefined, extra)).clean, false);
  }
});
test('rejects invalid lifecycle/version/archive evidence and accepts retained archive', () => {
  for (const extra of [
    { status: 'DELETED' },
    { version: 0 },
    { version: 1.5 },
    { version: '1' },
    { status: 'ARCHIVED' },
    { archivedAt: new Date() },
    { createdAt: '2026-10-14' },
  ]) {
    assert.equal(planTeamFoundation(snapshot([row(extra)])).clean, false);
  }
  assert.equal(
    planTeamFoundation(
      snapshot([
        row({
          status: 'ARCHIVED',
          archivedAt: new Date(),
          archivedBy: actor,
          archivedReason: 'Retained',
        }),
      ]),
    ).clean,
    true,
  );
});
test('blocks missing/drifted unique indexes and collection views/collation', () => {
  const base = snapshot();
  for (const index of [
    null,
    { ...base.objects.teams.indexes[0], unique: false },
    { ...base.objects.teams.indexes[0], sparse: true },
    { ...base.objects.teams.indexes[0], hidden: true },
    {
      ...base.objects.teams.indexes[0],
      partialFilterExpression: { status: 'ACTIVE' },
    },
    { ...base.objects.teams.indexes[0], collation: { locale: 'en' } },
  ]) {
    assert.equal(
      planTeamFoundation(
        snapshot([], {
          objects: {
            ...base.objects,
            teams: { type: 'collection', indexes: index ? [index] : [] },
          },
        }),
      ).clean,
      false,
    );
  }
  assert.equal(
    planTeamFoundation(
      snapshot([], { objects: { ...base.objects, teams: { type: 'view' } } }),
    ).clean,
    false,
  );
  assert.equal(
    planTeamFoundation(
      snapshot([], {
        objects: {
          ...base.objects,
          teams: {
            ...base.objects.teams,
            options: { collation: { locale: 'en' } },
          },
        },
      }),
    ).clean,
    false,
  );
});
test('rejects an incorrect logical database even for empty data', () => {
  assert.throws(
    () => planTeamFoundation(snapshot([], { databaseName: 'continuum_db' })),
    /IAM_TARGET_REQUIRED/,
  );
});
test('report contains issue identifiers and hashes, without name/description contents', () => {
  const report = planTeamFoundation(
    snapshot([
      row({ name: ' Secret Team ', description: 'Private\u0000description' }),
    ]),
  );
  assert.doesNotMatch(JSON.stringify(report), /Secret Team|Private/);
  assert.match(report.sourceSha256, /^[a-f0-9]{64}$/);
});
