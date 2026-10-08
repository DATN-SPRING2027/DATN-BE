import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { AuthorizationPolicy } from '../../application/authorization/authorization.policy';
import { MongoPlatformAuditRepository } from './platform-audit.repository';
import { MongoAuthorizationEvidenceProvider } from './authorization-evidence.provider';
import { MongoOrganizationProvisioningRepository } from './organization-provisioning.repository';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

integration('Platform Operator MongoDB persistence', () => {
  it('persists fresh platform evidence and atomically provisions Organization plus first ADMIN and audit', async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    const databaseName = `platform_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const auditDatabaseName = `${databaseName}_audit`;
    const connection = mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
    let createdDatabase = false;
    try {
      await connection.asPromise();
      const db = connection.db;
      if (!db || db.databaseName !== databaseName)
        throw new Error('Wrong or unavailable IAM test database');
      createdDatabase = true;
      const auditDb = connection.useDb(auditDatabaseName, { useCache: true });
      const collections = [
        'users',
        'organizations',
        'organization_memberships',
        'roles',
        'role_assignments',
        'platform_authority_assignments',
      ];
      for (const collection of collections) {
        await db.createCollection(collection);
        const definition = IAM_PERSISTENCE.collections.find(
          (item) => item.name === collection,
        );
        if (!definition)
          throw new Error(`${collection} persistence is missing`);
        await connection
          .model(
            `continuum_iam_${collection}`,
            createCollectionSchema(definition),
          )
          .createIndexes();
      }
      await auditDb.createCollection('audit_logs_iam');

      const actorId = new Types.ObjectId();
      const adminId = new Types.ObjectId();
      await db.collection('users').insertMany([
        { _id: actorId, email: 'operator@example.test', status: 'ACTIVE' },
        { _id: adminId, email: 'admin@example.test', status: 'ACTIVE' },
      ]);
      const adminRoleId = new Types.ObjectId();
      await db.collection('roles').insertOne({
        _id: adminRoleId,
        code: 'ADMIN',
        name: 'Organization Admin',
        permissions: [],
        isSystem: true,
      });

      const provider = new MongoAuthorizationEvidenceProvider(connection);
      const policy = new AuthorizationPolicy();
      const expiresAt = new Date(Date.now() + 60_000);
      await db.collection('platform_authority_assignments').insertOne({
        subjectUserId: actorId,
        permission: 'organization.create',
        scope: 'PLATFORM',
        status: 'ACTIVE',
        grantedAt: new Date(),
        grantedBy: new Types.ObjectId('eeeeeeeeeeeeeeeeeeeeeeee'),
        expiresAt,
        revokedAt: null,
      });
      const evidenceBeforeRevoke = await provider.loadPlatformPermission(
        String(actorId),
        'organization.create',
      );
      expect(
        policy.evaluatePlatformPermission({
          permission: 'organization.create',
          subject: { userId: String(actorId), status: 'ACTIVE' },
          assignments: evidenceBeforeRevoke?.assignments ?? [],
          now: new Date(),
        }).allowed,
      ).toBe(true);

      await db.collection('platform_authority_assignments').updateOne(
        {
          subjectUserId: actorId,
          permission: 'organization.create',
          scope: 'PLATFORM',
        },
        { $set: { status: 'REVOKED', revokedAt: new Date() } },
      );
      const evidenceAfterRevoke = await provider.loadPlatformPermission(
        String(actorId),
        'organization.create',
      );
      expect(
        policy.evaluatePlatformPermission({
          permission: 'organization.create',
          subject: { userId: String(actorId), status: 'ACTIVE' },
          assignments: evidenceAfterRevoke?.assignments ?? [],
          now: new Date(),
        }).allowed,
      ).toBe(false);

      const repository = new MongoOrganizationProvisioningRepository(
        connection,
        auditDatabaseName,
      );
      await expect(
        repository.create(String(actorId), {
          name: 'Invalid Bootstrap',
          slug: 'invalid-bootstrap',
          plan: 'FREE',
          firstAdminUserId: String(new Types.ObjectId()),
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await db.collection('organizations').countDocuments()).toBe(0);
      expect(
        await db.collection('organization_memberships').countDocuments(),
      ).toBe(0);
      expect(await db.collection('role_assignments').countDocuments()).toBe(0);
      expect(await auditDb.collection('audit_logs_iam').countDocuments()).toBe(
        0,
      );

      const first = await repository.create(String(actorId), {
        name: 'First Organization',
        slug: 'first-organization',
        plan: 'FREE',
        firstAdminUserId: String(adminId),
      });
      expect(first.id).toMatch(/^[a-f\d]{24}$/i);
      expect(await db.collection('organizations').countDocuments()).toBe(1);
      expect(
        await db.collection('organization_memberships').findOne({
          organizationId: new Types.ObjectId(first.id),
          userId: adminId,
          status: 'ACTIVE',
        }),
      ).not.toBeNull();
      expect(
        await db.collection('role_assignments').findOne({
          organizationId: new Types.ObjectId(first.id),
          userId: adminId,
          roleId: adminRoleId,
          roleCode: 'ADMIN',
          assignedBy: actorId,
        }),
      ).not.toBeNull();
      expect(
        await db.collection('organization_memberships').countDocuments({
          userId: actorId,
        }),
      ).toBe(0);
      expect(
        await db.collection('role_assignments').countDocuments({
          userId: actorId,
        }),
      ).toBe(0);
      expect(
        await auditDb.collection('audit_logs_iam').countDocuments({
          action: 'organization.create',
          targetResourceId: first.id,
          actorUserId: String(actorId),
        }),
      ).toBe(1);

      await auditDb.collection('audit_logs_iam').insertMany([
        {
          actorUserId: String(actorId),
          action: 'platform.authority.granted',
          targetResource: 'PLATFORM_AUTHORITY',
          targetResourceId: String(actorId),
          metadata: { secret: 'must-not-be-returned' },
          occurredAt: new Date(Date.now() - 1000),
        },
        {
          actorUserId: String(actorId),
          action: 'platform.authority.revoked',
          targetResource: 'PLATFORM_AUTHORITY',
          targetResourceId: String(actorId),
          metadata: { refreshToken: 'must-not-be-returned' },
          occurredAt: new Date(Date.now() - 2000),
        },
        {
          actorUserId: String(actorId),
          action: 'project.create',
          targetResource: 'PROJECT',
          targetResourceId: String(new Types.ObjectId()),
          metadata: { privateProjectContent: 'must-not-be-returned' },
          occurredAt: new Date(),
        },
      ]);

      const auditRepository = new MongoPlatformAuditRepository(
        connection,
        auditDatabaseName,
      );
      const visibleAudit = await auditRepository.listOperationalMetadata();
      expect(visibleAudit.map((event) => event.action)).toEqual([
        'organization.create',
        'platform.authority.granted',
        'platform.authority.revoked',
      ]);
      expect(visibleAudit[0]).toMatchObject({
        targetResource: 'ORGANIZATION',
        targetResourceId: first.id,
        actorUserId: String(actorId),
      });
      expect(visibleAudit.every((event) => !('metadata' in event))).toBe(true);

      // An audit write failure aborts Organization, membership, and role changes.
      await auditDb
        .collection('audit_logs_iam')
        .createIndex({ action: 1 }, { unique: true });
      await expect(
        repository.create(String(actorId), {
          name: 'Rolled Back Organization',
          slug: 'rolled-back-organization',
          plan: 'ENTERPRISE',
          firstAdminUserId: String(adminId),
        }),
      ).rejects.toMatchObject({ code: 11000 });
      expect(await db.collection('organizations').countDocuments()).toBe(1);
      expect(
        await db
          .collection('organizations')
          .countDocuments({ slug: 'rolled-back-organization' }),
      ).toBe(0);
      expect(
        await db.collection('organization_memberships').countDocuments(),
      ).toBe(1);
      expect(await db.collection('role_assignments').countDocuments()).toBe(1);
      expect(await auditDb.collection('audit_logs_iam').countDocuments()).toBe(
        4,
      );

      await expect(
        db.collection('platform_authority_assignments').insertOne({
          subjectUserId: actorId,
          permission: 'organization.create',
          scope: 'PLATFORM',
          status: 'ACTIVE',
          grantedAt: new Date(),
          grantedBy: actorId,
        }),
      ).rejects.toMatchObject({ code: 11000 });
    } finally {
      if (
        createdDatabase &&
        connection.readyState === mongoose.ConnectionStates.connected &&
        connection.db?.databaseName === databaseName
      )
        await connection.db.dropDatabase();
      if (createdDatabase)
        await connection.useDb(auditDatabaseName).dropDatabase();
      await connection.close();
    }
  }, 30_000);
});
