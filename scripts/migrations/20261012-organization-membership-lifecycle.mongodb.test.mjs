import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import mongoose from 'mongoose';
import { runMembershipLifecycleMigration } from './20261012-organization-membership-lifecycle.mjs';
const { MongoClient, ObjectId } = mongoose.mongo;
const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? test : test.skip;
const marker = 'datn-87-membership-lifecycle-mongo7-disposable';
integration(
  'DATN-87 lifecycle metadata migration on isolated MongoDB7 replica set',
  async (t) => {
    assert.equal(process.env.MONGODB_INTEGRATION_TARGET, marker);
    const uri = new URL(process.env.MONGODB_URI);
    assert.equal(uri.protocol, 'mongodb:');
    assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname));
    assert.equal(uri.username, '');
    assert.equal(uri.password, '');
    assert.ok(['27017', '28788'].includes(uri.port));
    assert.equal(uri.port, process.env.MONGODB_INTEGRATION_PORT);
    assert.equal(
      uri.searchParams.get('replicaSet'),
      process.env.MONGODB_INTEGRATION_REPLICA_SET ?? 'rs0',
    );
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
    const databaseName = `datn87_membership_db_test_${randomUUID().replaceAll('-', '')}`;
    assert.match(databaseName, /^datn87_membership_db_test_[a-f\d]{32}$/);
    let owned = false;
    try {
      const admin = client.db('admin');
      assert.equal((await admin.command({ buildInfo: 1 })).versionArray[0], 7);
      assert.ok((await admin.command({ hello: 1 })).isWritablePrimary);
      assert.ok(
        await admin
          .collection('datn_migration_test_fixture')
          .findOne({ _id: marker }),
      );
      assert.equal(
        (await admin.admin().listDatabases({ nameOnly: true })).databases.some(
          (row) => row.name === databaseName,
        ),
        false,
      );
      const db = client.db(databaseName);
      const at = new Date('2026-01-01T00:00:00.000Z');
      const user = new ObjectId(),
        target = new ObjectId(),
        org = new ObjectId(),
        member = new ObjectId(),
        targetMember = new ObjectId(),
        role = new ObjectId(),
        ordinaryRole = new ObjectId();
      await db.collection('users').insertMany([
        { _id: user, email: 'admin@example.test', status: 'ACTIVE' },
        { _id: target, email: 'member@example.test', status: 'ACTIVE' },
      ]);
      owned = true;
      await db
        .collection('organizations')
        .insertOne({ _id: org, name: 'Synthetic' });
      await db.collection('organization_memberships').insertMany([
        {
          _id: member,
          organizationId: org,
          userId: user,
          status: 'ACTIVE',
          createdAt: at,
          updatedAt: at,
        },
        {
          _id: targetMember,
          organizationId: org,
          userId: target,
          status: 'REMOVED',
          createdAt: at,
          updatedAt: at,
        },
      ]);
      await db.collection('roles').insertMany([
        {
          _id: role,
          code: 'ADMIN',
          isSystem: true,
          permissions: ['project.visibility.manage', 'project.leader.manage'],
        },
        {
          _id: ordinaryRole,
          code: 'MEMBER',
          isSystem: true,
          permissions: ['project.read'],
        },
      ]);
      await db.collection('role_assignments').insertMany([
        { organizationId: org, userId: user, roleId: role, roleCode: 'ADMIN' },
        {
          organizationId: org,
          userId: target,
          roleId: ordinaryRole,
          roleCode: 'MEMBER',
        },
      ]);
      await db.collection('organization_invitations').insertMany([
        {
          organizationId: org,
          email: 'unknown@example.test',
          roleCode: 'MEMBER',
          status: 'REVOKED',
          revokedAt: at,
          revokedBy: user,
          expiresAt: new Date('2026-01-08T00:00:00.000Z'),
          createdAt: at,
        },
        {
          organizationId: org,
          email: 'member@example.test',
          roleCode: 'MEMBER',
          status: 'ACCEPTED',
          acceptedAt: at,
          acceptedBy: target,
          expiresAt: new Date('2026-01-08T00:00:00.000Z'),
          createdAt: at,
        },
      ]);
      await db
        .collection('sentinel')
        .insertOne({ _id: 'preserve', privateData: 'unchanged' });
      const collections = [
        'users',
        'organizations',
        'organization_memberships',
        'roles',
        'role_assignments',
        'organization_invitations',
        'sentinel',
      ];
      const read = async () =>
        Object.fromEntries(
          await Promise.all(
            collections.map(async (name) => [
              name,
              await db.collection(name).find().sort({ _id: 1 }).toArray(),
            ]),
          ),
        );
      const before = await read();
      const run = (options = {}) =>
        runMembershipLifecycleMigration({
          uri: process.env.MONGODB_URI,
          databaseName,
          ...options,
        });
      let reviewed = await run();
      await t.test(
        'malformed legacy history actor BSON types block apply and preserve records',
        async () => {
          for (const field of ['acceptedBy', 'revokedBy']) {
            const source = await db
              .collection('organization_invitations')
              .findOne({ [field]: { $type: 'objectId' } });
            try {
              await db
                .collection('organization_invitations')
                .updateOne(
                  { _id: source._id },
                  { $set: { [field]: source[field].toHexString() } },
                );
              const blocked = await run();
              assert.equal(blocked.clean, false);
              assert.ok(
                blocked.issues.includes(
                  `INVITATION_ACTOR_REFERENCE_INVALID:${source._id}:${field}`,
                ),
              );
              await assert.rejects(
                run({
                  mode: 'apply',
                  writersStopped: true,
                  expectedReportSha256: blocked.reportSha256,
                }),
                /MIGRATION_PREFLIGHT_BLOCKED/,
              );
            } finally {
              await db
                .collection('organization_invitations')
                .updateOne(
                  { _id: source._id },
                  { $set: { [field]: source[field] } },
                );
            }
            assert.deepEqual(await read(), before);
          }
        },
      );
      await t.test(
        'unexpected history TTL blocks apply without dropping the index or changing records',
        async () => {
          const name = 'legacy_retention_cleanup';
          await db
            .collection('organization_invitations')
            .createIndex(
              { unknownRetentionAt: 1 },
              { name, expireAfterSeconds: 0 },
            );
          try {
            const blocked = await run();
            assert.equal(blocked.clean, false);
            assert.ok(
              blocked.issues.includes(
                `RETENTION_TTL_CONFLICT:organization_invitations:${name}`,
              ),
            );
            await assert.rejects(
              run({
                mode: 'apply',
                writersStopped: true,
                expectedReportSha256: blocked.reportSha256,
              }),
              /MIGRATION_PREFLIGHT_BLOCKED/,
            );
            assert.deepEqual(await read(), before);
            assert.ok(
              (
                await db
                  .collection('organization_invitations')
                  .listIndexes()
                  .toArray()
              ).some((index) => index.name === name),
            );
          } finally {
            // Only the index created by this disposable fixture is removed here.
            await db.collection('organization_invitations').dropIndex(name);
          }
        },
      );
      await t.test(
        'dry-run is read-only and writer/hash prerequisites prevent mutation',
        async () => {
          assert.equal(reviewed.clean, true);
          assert.equal(
            JSON.stringify(reviewed).includes('unknown@example.test'),
            false,
          );
          await assert.rejects(
            run({ mode: 'apply', expectedReportSha256: reviewed.reportSha256 }),
            /WRITERS/,
          );
          await assert.rejects(
            run({
              mode: 'apply',
              writersStopped: true,
              expectedReportSha256: '0'.repeat(64),
            }),
            /HASH/,
          );
          assert.deepEqual(await read(), before);
        },
      );
      await t.test(
        'early and late required-write failures roll back metadata and ADMIN permission union; additive DDL is retained',
        async () => {
          const totalWrites =
            reviewed.updates.length +
            reviewed.permissionAdditions.filter(
              (role) => role.missingPermissions.length,
            ).length;
          assert.ok(totalWrites > 1);
          assert.ok(
            reviewed.permissionAdditions.some(
              (role) => role.missingPermissions.length,
            ),
          );
          for (const failAt of [1, totalWrites]) {
            const failureReport = await run();
            let observedWrites = 0;
            await assert.rejects(
              run({
                mode: 'apply',
                writersStopped: true,
                expectedReportSha256: failureReport.reportSha256,
                testHooks: {
                  afterWrite: (writeCount) => {
                    observedWrites = writeCount;
                    if (writeCount === failAt)
                      throw new Error('INJECTED_FAILURE');
                  },
                },
              }),
              /INJECTED_FAILURE/,
            );
            assert.equal(observedWrites, failAt);
            assert.deepEqual(await read(), before);
          }
          assert.ok(
            (
              await db
                .collection('membership_operations')
                .listIndexes()
                .toArray()
            ).some((index) => index.name === 'membership_operation_key'),
          );
        },
      );
      reviewed = await run();
      await t.test(
        'atomic apply seeds independent versions/fences and unions only ADMIN permissions',
        async () => {
          await run({
            mode: 'apply',
            writersStopped: true,
            expectedReportSha256: reviewed.reportSha256,
          });
          assert.equal(
            (
              await db
                .collection('organization_memberships')
                .findOne({ _id: targetMember })
            ).status,
            'REMOVED',
          );
          assert.equal(
            (
              await db
                .collection('organization_memberships')
                .findOne({ _id: targetMember })
            ).version,
            1,
          );
          const invite = await db
            .collection('organization_invitations')
            .findOne();
          assert.equal(invite.status, 'REVOKED');
          assert.equal(invite.contractVersion, 1);
          assert.equal(invite.membershipId, undefined);
          assert.equal(invite.targetUserId, undefined);
          assert.deepEqual(
            (await db.collection('roles').findOne({ _id: ordinaryRole }))
              .permissions,
            ['project.read'],
          );
          assert.deepEqual(
            (await db.collection('roles').findOne({ _id: role })).permissions,
            [
              'project.visibility.manage',
              'project.leader.manage',
              'organization.memberships.read',
              'organization.memberships.manage',
            ],
          );
          assert.deepEqual(
            await db.collection('sentinel').find().toArray(),
            before.sentinel,
          );
        },
      );
      await t.test(
        'rerun is idempotent and stale reviewed data is refused',
        async () => {
          const after = await read();
          const report = await run();
          assert.equal(report.clean, true);
          assert.equal(report.updates.length, 0);
          await run({
            mode: 'apply',
            writersStopped: true,
            expectedReportSha256: report.reportSha256,
          });
          assert.deepEqual(await read(), after);
          await db
            .collection('organization_memberships')
            .updateOne(
              { _id: targetMember },
              { $set: { status: 'SUSPENDED' } },
            );
          await assert.rejects(
            run({
              mode: 'apply',
              writersStopped: true,
              expectedReportSha256: report.reportSha256,
            }),
            /HASH/,
          );
          await db
            .collection('organization_memberships')
            .updateOne({ _id: targetMember }, { $set: { status: 'REMOVED' } });
        },
      );
      await t.test(
        'actual pair/pending-invitation/scoped-operation unique indexes withstand concurrent contenders',
        async () => {
          await assert.rejects(
            db.collection('organization_memberships').insertOne({
              organizationId: org,
              userId: target,
              status: 'ACTIVE',
            }),
            (error) => error.code === 11000,
          );
          const contenders = [new ObjectId(), new ObjectId()];
          const results = await Promise.allSettled(
            contenders.map((_id, i) =>
              db.collection('organization_invitations').insertOne({
                _id,
                contractVersion: 2,
                membershipId: targetMember,
                targetUserId: target,
                organizationId: org,
                email: `race${i}@example.test`,
                status: 'PENDING',
              }),
            ),
          );
          assert.equal(
            results.filter((result) => result.status === 'fulfilled').length,
            1,
          );
          assert.equal(
            results.filter(
              (result) =>
                result.status === 'rejected' && result.reason.code === 11000,
            ).length,
            1,
          );
          await db
            .collection('organization_invitations')
            .deleteMany({ _id: { $in: contenders } });
          const keys = await Promise.allSettled(
            [0, 1].map(() =>
              db.collection('membership_operations').insertOne({
                actorUserId: user,
                organizationId: org,
                keyHash: 'a'.repeat(64),
                expiresAt: new Date(Date.now() + 86400000),
              }),
            ),
          );
          assert.equal(
            keys.filter((result) => result.status === 'fulfilled').length,
            1,
          );
          assert.equal(
            keys.filter(
              (result) =>
                result.status === 'rejected' && result.reason.code === 11000,
            ).length,
            1,
          );
          await db.collection('membership_operations').insertOne({
            actorUserId: target,
            organizationId: org,
            keyHash: 'a'.repeat(64),
            expiresAt: new Date(Date.now() + 86400000),
          });
          const indexes = await db
            .collection('membership_operations')
            .listIndexes()
            .toArray();
          assert.equal(
            indexes.find(
              (index) => index.name === 'membership_operation_expiry',
            ).expireAfterSeconds,
            0,
          );
          assert.equal(
            (
              await db
                .collection('organization_invitations')
                .listIndexes()
                .toArray()
            ).some((index) => 'expireAfterSeconds' in index),
            false,
          );
          await db.collection('membership_operations').deleteMany({});
        },
      );
      await t.test(
        'rollback refuses changed counters, then restores exact metadata/permission snapshot idempotently',
        async () => {
          await db
            .collection('organization_memberships')
            .updateOne({ _id: member }, { $inc: { mutationFence: 1 } });
          let current = await run();
          await assert.rejects(
            run({
              mode: 'rollback',
              writersStopped: true,
              expectedReportSha256: current.reportSha256,
              rollbackReport: JSON.parse(JSON.stringify(reviewed)),
            }),
            /ROLLBACK/,
          );
          await db
            .collection('organization_memberships')
            .updateOne({ _id: member }, { $set: { mutationFence: 0 } });
          current = await run();
          await run({
            mode: 'rollback',
            writersStopped: true,
            expectedReportSha256: current.reportSha256,
            rollbackReport: JSON.parse(JSON.stringify(reviewed)),
          });
          assert.deepEqual(await read(), before);
          current = await run();
          await run({
            mode: 'rollback',
            writersStopped: true,
            expectedReportSha256: current.reportSha256,
            rollbackReport: JSON.parse(JSON.stringify(reviewed)),
          });
          assert.deepEqual(await read(), before);
        },
      );
    } finally {
      if (owned) {
        assert.match(databaseName, /^datn87_membership_db_test_[a-f\d]{32}$/);
        await client.db(databaseName).dropDatabase();
      }
      await client.close();
    }
  },
);
