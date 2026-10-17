import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import {
  inspectTeamFoundation,
  runTeamFoundationPreflight,
} from './20261014-team-foundation-preflight.mjs';

const require = createRequire(import.meta.url);
require('ts-node/register');
const {
  createCollectionSchema,
} = require('../../src/services/iam/infrastructure/mongodb/mongodb.schemas.ts');
const {
  IAM_PERSISTENCE,
} = require('../../src/services/iam/infrastructure/persistence.ts');
const integration =
  process.env.DATN254_MONGODB_TEST === 'true' ? test : test.skip;

test('apply and ambiguous target are rejected before any connection', async () => {
  await assert.rejects(
    runTeamFoundationPreflight(['--apply', '--database', 'continuum_iam'], {}),
    /DRY_RUN/,
  );
  await assert.rejects(
    runTeamFoundationPreflight(['--dry-run', '--database', 'continuum_db'], {}),
    /DRY_RUN/,
  );
});

integration(
  'MongoDB 7 selected-rule preflight is read-only and preserves scoped uniqueness',
  async () => {
    const uri = process.env.DATN254_TEST_URI;
    assert.equal(uri, 'mongodb://127.0.0.1:28954/?directConnection=true');
    assert.ok(process.env.DATN254_FIXTURE_TOKEN);
    const connection = await mongoose
      .createConnection(uri, {
        dbName: 'continuum_iam',
        autoIndex: false,
        serverSelectionTimeoutMS: 5000,
      })
      .asPromise();
    try {
      const db = connection.db;
      const marker = await db
        .collection('__datn254_fixture')
        .findOne({ _id: 'owner' });
      assert.equal(marker?.token, process.env.DATN254_FIXTURE_TOKEN);
      assert.match(
        (await db.admin().command({ buildInfo: 1 })).version,
        /^7\.0\./,
      );
      assert.equal(
        await db.collection('teams').countDocuments(),
        0,
        'requires a fresh marked fixture',
      );
      for (const name of ['organizations', 'projects', 'teams'])
        await db.createCollection(name);
      const org = new mongoose.Types.ObjectId(),
        project = new mongoose.Types.ObjectId(),
        otherProject = new mongoose.Types.ObjectId(),
        actor = new mongoose.Types.ObjectId();
      await db.collection('organizations').insertOne({ _id: org });
      await db.collection('projects').insertMany([
        { _id: project, organizationId: org },
        { _id: otherProject, organizationId: org },
      ]);
      const definition = IAM_PERSISTENCE.collections.find(
        (item) => item.name === 'teams',
      );
      const TeamIndexes = connection.model(
        'TeamFoundationDisposableTest',
        createCollectionSchema(definition),
      );
      await TeamIndexes.createIndexes();
      const timestamp = new Date('2026-10-14T00:00:00.000Z');
      const input = {
        organizationId: org,
        projectId: project,
        name: 'Example',
        code: 'EX',
        description: null,
        status: 'ACTIVE',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        archivedBy: null,
        archivedReason: null,
      };
      await db.collection('teams').insertOne(input);
      await assert.rejects(
        db.collection('teams').insertOne({
          ...input,
          _id: new mongoose.Types.ObjectId(),
          status: 'ARCHIVED',
          archivedAt: new Date(),
          archivedBy: actor,
          archivedReason: 'Retain',
        }),
        (error) =>
          error.code === 11000 &&
          JSON.stringify(error.keyPattern) ===
            JSON.stringify({ organizationId: 1, projectId: 1, code: 1 }),
      );
      await db
        .collection('teams')
        .insertOne({
          ...input,
          _id: new mongoose.Types.ObjectId(),
          projectId: otherProject,
        });
      const state = async () => ({
        rows: await db.collection('teams').find().sort({ _id: 1 }).toArray(),
        indexes: await db.collection('teams').listIndexes().toArray(),
      });
      const before = await state();
      const clean = await inspectTeamFoundation(db, 'synthetic-fixture');
      assert.equal(clean.clean, true);
      assert.equal(clean.assessmentBasis.decisionStatus, 'PROPOSED');
      assert.equal(clean.assessmentBasis.authoritySignoff, 'PENDING');
      assert.equal(
        clean.assessmentBasis.proposedDispositions['TQ-01'],
        'APPROVE',
      );
      assert.deepEqual(clean.assessmentBasis.proposedDispositions['TQ-09'], {
        contract: 'APPROVE',
        mutations: 'DEFER',
      });
      assert.equal(clean.assessmentBasis.rolloutReady, false);
      assert.deepEqual(await state(), before);
      assert.deepEqual(
        await inspectTeamFoundation(db, 'synthetic-fixture'),
        clean,
      );
      // Raw legacy records are reported, never normalized or assigned ACTIVE.
      await db.collection('teams').insertOne({
        organizationId: org,
        projectId: project,
        name: ' e\u0301 ',
        code: ' ex ',
      });
      const legacyBefore = await state();
      const blocked = await inspectTeamFoundation(db, 'synthetic-fixture');
      assert.equal(blocked.clean, false);
      for (const code of [
        'CODE_COLLISION',
        'LIFECYCLE_MAPPING_REQUIRED',
        'VERSION_MAPPING_REQUIRED',
      ])
        assert.ok(blocked.issues.some((issue) => issue.code === code));
      assert.deepEqual(await state(), legacyBefore);
      const cli = await runTeamFoundationPreflight(
        ['--dry-run', '--database', 'continuum_iam'],
        { MONGODB_URI: uri },
      );
      assert.equal(cli, 2);
      assert.deepEqual(await state(), legacyBefore);
      // Drift is observed without repair, including removal of the required index.
      await db
        .collection('teams')
        .dropIndex('organizationId_1_projectId_1_code_1');
      const driftBefore = await state();
      assert.ok(
        (await inspectTeamFoundation(db, 'synthetic-fixture')).issues.some(
          (issue) => issue.code === 'CODE_INDEX_REVIEW_REQUIRED',
        ),
      );
      assert.deepEqual(await state(), driftBefore);
    } finally {
      await connection.close();
    }
  },
);
