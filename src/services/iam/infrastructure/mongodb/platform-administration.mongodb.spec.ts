/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Mongoose query doubles expose driver any types. */
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type { PlatformMembershipSuspendInput } from '../../application/organizations/organization-membership-command.repository';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoOrganizationMembershipCommandRepository } from './organization-membership-command.repository';
import { MongoPlatformAdministrationRepository } from './platform-administration.repository';
import { MongoPlatformAuditRepository } from './platform-audit.repository';

describe('Platform administration Mongo projections and membership lifecycle', () => {
  jest.setTimeout(120_000);

  let replicaSet: MongoMemoryReplSet;
  let connection: Connection;
  let administration: MongoPlatformAdministrationRepository;
  let commands: MongoOrganizationMembershipCommandRepository;

  const databaseName = `platform_admin_${randomUUID().replaceAll('-', '')}`;
  const organizationId = new Types.ObjectId();
  const foreignOrganizationId = new Types.ObjectId();
  const actorId = new Types.ObjectId();
  const adminId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const membershipId = new Types.ObjectId();
  const adminMembershipId = new Types.ObjectId();
  const projectId = new Types.ObjectId();
  const foreignProjectId = new Types.ObjectId();
  const roleId = new Types.ObjectId();
  const memberRoleId = new Types.ObjectId();
  const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;
  const platformPermission = 'platform.memberships.lifecycle.manage';
  const audit = () =>
    connection
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME);

  function suspendInput(
    overrides: Partial<PlatformMembershipSuspendInput> = {},
  ): PlatformMembershipSuspendInput {
    return {
      actorUserId: actorId.toHexString(),
      organizationId: organizationId.toHexString(),
      membershipId: membershipId.toHexString(),
      idempotencyKey: `platform-suspend-${randomUUID()}`,
      expectedMembershipVersion: 4,
      reasonCode: 'ACCESS_REVIEW',
      now: new Date('2026-10-16T00:00:00.000Z'),
      ...overrides,
    };
  }

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: {
        count: 1,
        name: 'test-rs-platform-administration',
        storageEngine: 'wiredTiger',
      },
    });
    connection = mongoose.createConnection(replicaSet.getUri(), {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    });
    await connection.asPromise();
    for (const name of [
      'users',
      'organizations',
      'organization_memberships',
      'organization_invitations',
      'membership_operations',
      'roles',
      'role_assignments',
      'platform_authority_assignments',
      'platform_authority_change_locks',
      'refresh_sessions',
      'projects',
      'project_memberships',
    ]) {
      await connection.createCollection(name);
      const definition = IAM_PERSISTENCE.collections.find(
        (collection) => collection.name === name,
      );
      if (!definition)
        throw new Error(`Missing IAM collection definition: ${name}`);
      await connection
        .model(modelName(name), createCollectionSchema(definition))
        .createIndexes();
    }
    const auditDatabase = connection.useDb(AUDIT_DATABASE_NAME, {
      useCache: true,
    });
    await auditDatabase.createCollection(IAM_AUDIT_COLLECTION_NAME);
    administration = new MongoPlatformAdministrationRepository(connection);
    commands = new MongoOrganizationMembershipCommandRepository(connection);
  });

  afterAll(async () => {
    await connection?.close();
    await replicaSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [
      'users',
      'organizations',
      'organization_memberships',
      'organization_invitations',
      'membership_operations',
      'roles',
      'role_assignments',
      'platform_authority_assignments',
      'platform_authority_change_locks',
      'refresh_sessions',
      'projects',
      'project_memberships',
    ])
      await connection.collection(name).deleteMany({});
    await audit().deleteMany({});
    await connection.collection('organizations').insertMany([
      {
        _id: organizationId,
        name: 'Platform Organization',
        slug: 'platform-organization',
        plan: 'FREE',
        settings: { privateSecret: 'never-return-this' },
        membershipAdminRevision: 0,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
      {
        _id: foreignOrganizationId,
        name: 'Foreign Organization',
        slug: 'foreign-organization',
        plan: 'ENTERPRISE',
        settings: { privateSecret: 'foreign-secret' },
        membershipAdminRevision: 0,
        createdAt: new Date('2026-10-02T00:00:00.000Z'),
        updatedAt: new Date('2026-10-02T00:00:00.000Z'),
      },
    ]);
    await connection.collection('users').insertMany([
      {
        _id: actorId,
        email: 'operator@example.test',
        fullName: 'Platform Operator',
        passwordHash: 'password-secret',
        twoFactorSecretEncrypted: 'mfa-secret',
        status: 'ACTIVE',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
      {
        _id: adminId,
        email: 'admin@example.test',
        fullName: 'Organization Admin',
        passwordHash: 'admin-password-secret',
        status: 'ACTIVE',
        createdAt: new Date('2026-09-02T00:00:00.000Z'),
        updatedAt: new Date('2026-10-02T00:00:00.000Z'),
      },
      {
        _id: memberId,
        email: 'member@example.test',
        fullName: 'Organization Member',
        passwordHash: 'member-password-secret',
        status: 'ACTIVE',
        createdAt: new Date('2026-09-03T00:00:00.000Z'),
        updatedAt: new Date('2026-10-03T00:00:00.000Z'),
      },
    ]);
    await connection.collection('organization_memberships').insertMany([
      {
        _id: membershipId,
        organizationId,
        userId: memberId,
        status: 'ACTIVE',
        version: 4,
        mutationFence: 0,
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        updatedAt: new Date('2026-10-03T00:00:00.000Z'),
      },
      {
        _id: adminMembershipId,
        organizationId,
        userId: adminId,
        status: 'ACTIVE',
        version: 1,
        mutationFence: 0,
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        updatedAt: new Date('2026-10-03T00:00:00.000Z'),
      },
      {
        _id: new Types.ObjectId(),
        organizationId: foreignOrganizationId,
        userId: memberId,
        status: 'ACTIVE',
        version: 1,
        mutationFence: 0,
        createdAt: new Date('2026-10-04T00:00:00.000Z'),
        updatedAt: new Date('2026-10-04T00:00:00.000Z'),
      },
    ]);
    await connection.collection('projects').insertMany([
      {
        _id: projectId,
        organizationId,
        name: 'Private project alpha',
        code: 'ALPHA',
        description: 'private tenant content must not be projected',
        visibility: 'PRIVATE',
        status: 'ACTIVE',
        createdBy: adminId,
        createdAt: new Date('2026-10-05T00:00:00.000Z'),
        updatedAt: new Date('2026-10-06T00:00:00.000Z'),
      },
      {
        _id: foreignProjectId,
        organizationId: foreignOrganizationId,
        name: 'Archived project beta',
        code: 'BETA',
        description: 'foreign tenant content',
        visibility: 'PUBLIC',
        status: 'ARCHIVED',
        createdBy: adminId,
        createdAt: new Date('2026-10-07T00:00:00.000Z'),
        updatedAt: new Date('2026-10-08T00:00:00.000Z'),
      },
    ]);
    await connection.collection('project_memberships').insertOne({
      organizationId,
      projectId,
      userId: memberId,
      status: 'ACTIVE',
      joinedAt: new Date('2026-10-05T00:00:00.000Z'),
    });
    await connection.collection('roles').insertOne({
      _id: roleId,
      code: 'ADMIN',
      name: 'Admin',
      isSystem: true,
      permissions: ['organization.memberships.manage'],
    });
    await connection.collection('roles').insertOne({
      _id: memberRoleId,
      code: 'MEMBER',
      name: 'Member',
      isSystem: true,
      permissions: [],
    });
    await connection.collection('role_assignments').insertOne({
      organizationId,
      projectId: null,
      userId: adminId,
      roleId,
      roleCode: 'ADMIN',
      assignedBy: actorId,
    });
    await connection.collection('role_assignments').insertOne({
      organizationId,
      projectId: null,
      userId: memberId,
      roleId: memberRoleId,
      roleCode: 'MEMBER',
      assignedBy: adminId,
    });
    await connection.collection('role_assignments').insertOne({
      organizationId,
      projectId,
      userId: memberId,
      roleId,
      roleCode: 'MEMBER',
      assignedBy: adminId,
    });
    await connection.collection('role_assignments').insertOne({
      organizationId,
      projectId,
      userId: adminId,
      roleId,
      roleCode: 'TEAM_LEADER',
      assignedBy: actorId,
    });
    await connection.collection('platform_authority_assignments').insertOne({
      subjectUserId: memberId,
      permission: 'platform.health.read',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      grantedBy: adminId,
      expiresAt: null,
      revokedAt: null,
      provenanceOperationId: 'test-member-platform-permission',
    });
    await connection.collection('platform_authority_assignments').insertOne({
      subjectUserId: actorId,
      permission: platformPermission,
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      grantedBy: adminId,
      expiresAt: null,
      revokedAt: null,
      provenanceOperationId: 'test-platform-authority-operation',
    });
    await connection.collection('platform_authority_assignments').insertOne({
      subjectUserId: actorId,
      permission: 'platform.users.account.manage',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      grantedBy: adminId,
      expiresAt: null,
      revokedAt: null,
      provenanceOperationId: 'test-platform-user-manager',
    });
    await connection.collection('platform_authority_assignments').insertMany([
      {
        subjectUserId: actorId,
        permission: 'platform.organizations.organization.manage',
        scope: 'PLATFORM',
        status: 'ACTIVE',
        grantedAt: new Date('2026-10-01T00:00:00.000Z'),
        grantedBy: adminId,
        expiresAt: null,
        revokedAt: null,
        provenanceOperationId: 'test-platform-organization-manager',
      },
      {
        subjectUserId: actorId,
        permission: 'platform.projects.project.manage',
        scope: 'PLATFORM',
        status: 'ACTIVE',
        grantedAt: new Date('2026-10-01T00:00:00.000Z'),
        grantedBy: adminId,
        expiresAt: null,
        revokedAt: null,
        provenanceOperationId: 'test-platform-project-manager',
      },
      {
        subjectUserId: actorId,
        permission: 'platform.sessions.session.manage',
        scope: 'PLATFORM',
        status: 'ACTIVE',
        grantedAt: new Date('2026-10-01T00:00:00.000Z'),
        grantedBy: adminId,
        expiresAt: null,
        revokedAt: null,
        provenanceOperationId: 'test-platform-session-manager',
      },
    ]);
    await connection.collection('platform_authority_change_locks').insertOne({
      permission: 'PLATFORM_OPERATOR_LIFECYCLE',
      scope: 'PLATFORM',
      version: 0,
    });
  });

  it('returns bounded Organization, exact User, and Organization-scoped Membership projections', async () => {
    const organizations = await administration.listOrganizations(1, 20);
    expect(organizations.data.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: foreignOrganizationId.toHexString(), name: 'Foreign Organization' },
      { id: organizationId.toHexString(), name: 'Platform Organization' },
    ]);
    expect(JSON.stringify(organizations)).not.toContain('privateSecret');

    const user = await administration.findActiveUserByExactEmail(
      'member@example.test',
    );
    expect(user).toEqual({
      id: memberId.toHexString(),
      email: 'member@example.test',
      fullName: 'Organization Member',
      status: 'ACTIVE',
    });
    expect(JSON.stringify(user)).not.toContain('passwordHash');
    const memberships = await administration.listOrganizationMemberships({
      organizationId: organizationId.toHexString(),
      page: 1,
      pageSize: 20,
    });
    expect(memberships.data).toHaveLength(2);
    expect(
      memberships.data
        .map((row) => row.organizationId)
        .every((id) => id === organizationId.toHexString()),
    ).toBe(true);
    const member = memberships.data.find(
      (row) => row.id === membershipId.toHexString(),
    );
    expect(member).toMatchObject({
      user: {
        email: 'member@example.test',
        fullName: 'Organization Member',
      },
      organizationRoles: ['MEMBER'],
    });
    expect(JSON.stringify(memberships)).not.toContain('password-secret');
    expect(JSON.stringify(memberships)).not.toContain('permissions');
  });

  it('lists and details Users across Organizations with filters and safe effective-permission projections', async () => {
    const page = await administration.listUsers({
      page: 1,
      pageSize: 10,
      search: 'member@example',
      status: 'ACTIVE',
      organizationId: organizationId.toHexString(),
      roleCode: 'MEMBER',
    });
    expect(page).toMatchObject({
      pagination: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
    });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: memberId.toHexString(),
      email: 'member@example.test',
      status: 'ACTIVE',
      memberships: [
        {
          organizationId: organizationId.toHexString(),
          organizationRoles: ['MEMBER'],
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('member-password-secret');

    const detail = await administration.findUser(memberId.toHexString());
    expect(detail).toMatchObject({
      id: memberId.toHexString(),
      memberships: expect.arrayContaining([
        expect.objectContaining({
          organizationId: organizationId.toHexString(),
        }),
        expect.objectContaining({
          organizationId: foreignOrganizationId.toHexString(),
        }),
      ]),
      effectivePlatformPermissions: [
        expect.objectContaining({
          permission: 'platform.health.read',
          scope: 'PLATFORM',
          status: 'ACTIVE',
          source: 'PLATFORM_AUTHORITY_ASSIGNMENT',
        }),
      ],
    });
    expect(JSON.stringify(detail)).not.toContain('member-password-secret');
    expect(JSON.stringify(detail)).not.toContain('privateSecret');
    expect(JSON.stringify(detail)).not.toContain('provenanceOperationId');

    const userOrganizations = await administration.listUserOrganizations({
      userId: memberId.toHexString(),
      page: 1,
      pageSize: 1,
      status: 'ACTIVE',
    });
    if (!userOrganizations)
      throw new Error('Expected a user organization page.');
    expect(userOrganizations.pagination).toEqual({
      page: 1,
      pageSize: 1,
      totalItems: 2,
      totalPages: 2,
    });
    expect(userOrganizations.data).toHaveLength(1);
    expect(userOrganizations.data[0]).toMatchObject({
      organizationId: foreignOrganizationId.toHexString(),
      organizationName: 'Foreign Organization',
      status: 'ACTIVE',
    });
  });

  it('lists Platform-safe Projects and computes real dashboard aggregates', async () => {
    const page = await administration.listProjects({
      page: 1,
      pageSize: 10,
      search: 'ALP',
      organizationId: organizationId.toHexString(),
      visibility: 'PRIVATE',
      status: 'ACTIVE',
    });
    expect(page).toMatchObject({
      pagination: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
      data: [
        {
          id: projectId.toHexString(),
          organization: { id: organizationId.toHexString() },
          name: 'Private project alpha',
          code: 'ALPHA',
          visibility: 'PRIVATE',
          status: 'ACTIVE',
          memberCount: 1,
          leaders: [{ id: adminId.toHexString(), email: 'admin@example.test' }],
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('private tenant content');
    expect(JSON.stringify(page)).not.toContain('foreign tenant content');
    expect(JSON.stringify(page)).not.toContain('password-secret');
    await expect(
      administration.findProject(foreignProjectId.toHexString()),
    ).resolves.toMatchObject({ id: foreignProjectId.toHexString() });

    const summary = await administration.getDashboardSummary(
      new Date('2026-10-16T00:00:00.000Z'),
    );
    expect(summary).toEqual({
      organizations: { total: 2 },
      users: { total: 3, active: 3, suspended: 0, pendingInvite: 0 },
      projects: { total: 2, active: 1, archived: 1 },
      memberships: {
        total: 3,
        active: 3,
        suspended: 0,
        pendingInvite: 0,
        removed: 0,
      },
      generatedAt: '2026-10-16T00:00:00.000Z',
    });
  });

  it('lists Project member identity and status only within the persisted organization and project', async () => {
    const page = await administration.listProjectMemberships({
      projectId: projectId.toHexString(),
      organizationId: organizationId.toHexString(),
      page: 1,
      pageSize: 10,
      search: 'member@example',
      status: 'ACTIVE',
    });
    expect(page).toMatchObject({
      pagination: { totalItems: 1, page: 1, pageSize: 10, totalPages: 1 },
      data: [
        {
          projectId: projectId.toHexString(),
          organizationId: organizationId.toHexString(),
          user: {
            id: memberId.toHexString(),
            email: 'member@example.test',
          },
          status: 'ACTIVE',
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('private tenant content');
    expect(JSON.stringify(page)).not.toContain('password-secret');
    expect(JSON.stringify(page)).not.toContain('roleId');

    const foreign = await administration.listProjectMemberships({
      projectId: projectId.toHexString(),
      organizationId: foreignOrganizationId.toHexString(),
      page: 1,
      pageSize: 10,
    });
    expect(foreign.data).toEqual([]);
  });

  it('lists and reads memberships across organizations with stable filters and safe metadata', async () => {
    const page = await administration.listPlatformMemberships({
      page: 1,
      pageSize: 10,
      search: 'member@example',
      status: 'ACTIVE',
      organizationId: organizationId.toHexString(),
      roleCode: 'MEMBER',
    });
    expect(page.pagination).toEqual({
      page: 1,
      pageSize: 10,
      totalItems: 1,
      totalPages: 1,
    });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: membershipId.toHexString(),
      organizationId: organizationId.toHexString(),
      organization: {
        id: organizationId.toHexString(),
        name: 'Platform Organization',
      },
      user: { email: 'member@example.test' },
      organizationRoles: ['MEMBER'],
    });
    expect(JSON.stringify(page)).not.toContain('privateSecret');
    expect(JSON.stringify(page)).not.toContain('password-secret');
    expect(JSON.stringify(page)).not.toContain('permissions');

    await expect(
      administration.findPlatformMembership(membershipId.toHexString()),
    ).resolves.toMatchObject({
      id: membershipId.toHexString(),
      organization: { slug: 'platform-organization' },
      user: { id: memberId.toHexString() },
    });
    await expect(
      administration.findPlatformMembership(new Types.ObjectId().toHexString()),
    ).resolves.toBeNull();
  });

  it('reads pending invitation metadata through the Platform-safe owner query', async () => {
    const invitationId = new Types.ObjectId();
    const pendingMembershipId = new Types.ObjectId();
    const invitedUserId = new Types.ObjectId();
    await connection.collection('users').insertOne({
      _id: invitedUserId,
      email: 'invitee@example.test',
      fullName: 'Pending Invitee',
      status: 'ACTIVE',
      createdAt: new Date('2026-10-15T00:00:00.000Z'),
      updatedAt: new Date('2026-10-15T00:00:00.000Z'),
    });
    await connection.collection('organization_memberships').insertOne({
      _id: pendingMembershipId,
      organizationId,
      userId: invitedUserId,
      status: 'PENDING_INVITE',
      version: 1,
      mutationFence: 0,
      createdAt: new Date('2026-10-15T00:00:00.000Z'),
      updatedAt: new Date('2026-10-15T00:00:00.000Z'),
    });
    await connection.collection('organization_invitations').insertOne({
      _id: invitationId,
      organizationId,
      membershipId: pendingMembershipId,
      targetUserId: invitedUserId,
      email: 'invitee@example.test',
      contractVersion: 2,
      version: 1,
      status: 'PENDING',
      invitedBy: adminId,
      expiresAt: new Date('2026-10-23T00:00:00.000Z'),
      createdAt: new Date('2026-10-16T00:00:00.000Z'),
      invitationTokenHash: 'must-not-be-projected',
    });
    const page = await commands.listInvitations(
      organizationId.toHexString(),
      1,
      10,
      new Date('2026-10-16T00:00:00.000Z'),
    );
    expect(page).toMatchObject({
      pagination: { totalItems: 1, page: 1, pageSize: 10 },
      data: [
        {
          id: invitationId.toHexString(),
          membershipId: pendingMembershipId.toHexString(),
          organizationId: organizationId.toHexString(),
          status: 'PENDING',
          targetUserId: invitedUserId.toHexString(),
          email: 'invitee@example.test',
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('must-not-be-projected');
  });

  it('updates Organization and Project metadata with fresh authority, CAS and atomic audit', async () => {
    const organizationUpdatedAt = new Date('2026-10-01T00:00:00.000Z');
    const projectUpdatedAt = new Date('2026-10-06T00:00:00.000Z');
    const now = new Date('2026-10-16T12:00:00.000Z');
    const organization = await administration.changeOrganizationMetadata({
      actorUserId: actorId.toHexString(),
      organizationId: organizationId.toHexString(),
      expectedUpdatedAt: organizationUpdatedAt,
      name: 'Platform Organization Updated',
      slug: 'platform-organization-updated',
      reasonCode: 'ACCESS_REVIEW',
      correlationId: 'platform-org-edit-001',
      now,
    });
    expect(organization).toMatchObject({
      id: organizationId.toHexString(),
      name: 'Platform Organization Updated',
      slug: 'platform-organization-updated',
      plan: 'FREE',
      updatedAt: now.toISOString(),
    });
    expect(JSON.stringify(organization)).not.toContain('privateSecret');

    const project = await administration.changeProjectMetadata({
      actorUserId: actorId.toHexString(),
      projectId: projectId.toHexString(),
      expectedUpdatedAt: projectUpdatedAt,
      name: 'Updated project alpha',
      code: 'ALPHA2',
      visibility: 'PUBLIC',
      reasonCode: 'ACCESS_REVIEW',
      correlationId: 'platform-project-edit-001',
      now,
    });
    expect(project).toMatchObject({
      id: projectId.toHexString(),
      name: 'Updated project alpha',
      code: 'ALPHA2',
      visibility: 'PUBLIC',
      updatedAt: now.toISOString(),
    });
    expect(JSON.stringify(project)).not.toContain('private tenant content');

    const logs = await audit().find({}).sort({ action: 1 }).toArray();
    expect(logs).toHaveLength(2);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'platform.organization.metadata.changed',
          targetResource: 'ORGANIZATION',
          targetResourceId: organizationId.toHexString(),
          scope: 'PLATFORM',
          actorUserId: actorId.toHexString(),
          requestId: 'platform-org-edit-001',
        }),
        expect.objectContaining({
          action: 'platform.project.metadata.changed',
          targetResource: 'PROJECT',
          targetResourceId: projectId.toHexString(),
          organizationId: organizationId.toHexString(),
          scope: 'PLATFORM',
          actorUserId: actorId.toHexString(),
          requestId: 'platform-project-edit-001',
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain('privateSecret');
    expect(JSON.stringify(logs)).not.toContain('private tenant content');

    await expect(
      administration.changeProjectMetadata({
        actorUserId: actorId.toHexString(),
        projectId: projectId.toHexString(),
        expectedUpdatedAt: projectUpdatedAt,
        name: 'Stale name',
        reasonCode: 'ACCESS_REVIEW',
        now,
      }),
    ).rejects.toMatchObject({ response: { code: 'PROJECT_VERSION_STALE' } });
  });

  it('changes a User account status with fresh Platform authority, last-admin protection, session revocation and atomic audit', async () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    await connection.collection('refresh_sessions').insertOne({
      userId: memberId,
      context: 'ORGANIZATION',
      organizationId,
      tokenHash: 'refresh-token-hash-secret',
      isRevoked: false,
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    });
    const result = await administration.changeUserStatus({
      actorUserId: actorId.toHexString(),
      userId: memberId.toHexString(),
      status: 'SUSPENDED',
      expectedUpdatedAt: new Date('2026-10-03T00:00:00.000Z'),
      reasonCode: 'ACCESS_REVIEW',
      now,
    });

    expect(result).toMatchObject({
      id: memberId.toHexString(),
      status: 'SUSPENDED',
      updatedAt: now.toISOString(),
    });
    expect(
      await connection
        .collection('refresh_sessions')
        .findOne({ userId: memberId }),
    ).toMatchObject({ isRevoked: true });
    const logs = await audit().find({}).toArray();
    expect(logs).toContainEqual(
      expect.objectContaining({
        action: 'platform.user.status.changed',
        targetResource: 'USER',
        targetResourceId: memberId.toHexString(),
        actorUserId: actorId.toHexString(),
        scope: 'PLATFORM',
        result: 'SUCCESS',
        reasonCode: 'ACCESS_REVIEW',
      }),
    );
    expect(JSON.stringify(logs)).not.toContain('refresh-token-hash-secret');
    const safeAudit = await new MongoPlatformAuditRepository(
      connection,
      AUDIT_DATABASE_NAME,
    ).listOperationalMetadata();
    expect(safeAudit).toContainEqual(
      expect.objectContaining({
        action: 'platform.user.status.changed',
        targetResource: 'USER',
        targetResourceId: memberId.toHexString(),
        actorUserId: actorId.toHexString(),
      }),
    );

    await expect(
      administration.changeUserStatus({
        actorUserId: actorId.toHexString(),
        userId: adminId.toHexString(),
        status: 'SUSPENDED',
        expectedUpdatedAt: new Date('2026-10-02T00:00:00.000Z'),
        reasonCode: 'SECURITY_INCIDENT',
        now,
      }),
    ).rejects.toMatchObject({ response: { code: 'LAST_ELIGIBLE_ADMIN' } });
  });

  it('rejects a stale status version even when the requested status already matches', async () => {
    await expect(
      administration.changeUserStatus({
        actorUserId: actorId.toHexString(),
        userId: memberId.toHexString(),
        status: 'ACTIVE',
        expectedUpdatedAt: new Date('2026-10-02T00:00:00.000Z'),
        reasonCode: 'ACCESS_REVIEW',
        now: new Date('2026-10-16T12:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ response: { code: 'USER_VERSION_STALE' } });
    expect(await audit().countDocuments()).toBe(0);
  });

  it('reactivates only suspended users without restoring revoked sessions', async () => {
    const suspendedAt = new Date('2026-10-15T12:00:00.000Z');
    const now = new Date('2026-10-16T12:00:00.000Z');
    await connection
      .collection('users')
      .updateOne(
        { _id: memberId },
        { $set: { status: 'SUSPENDED', updatedAt: suspendedAt } },
      );
    await connection.collection('refresh_sessions').insertOne({
      userId: memberId,
      context: 'ORGANIZATION',
      organizationId,
      tokenHash: 'reactivation-revoked-session-secret',
      isRevoked: true,
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
      createdAt: suspendedAt,
      updatedAt: suspendedAt,
    });

    const result = await administration.changeUserStatus({
      actorUserId: actorId.toHexString(),
      userId: memberId.toHexString(),
      status: 'ACTIVE',
      expectedUpdatedAt: suspendedAt,
      reasonCode: 'ACCESS_REVIEW',
      correlationId: 'user-reactivation-1',
      now,
    });

    expect(result).toMatchObject({
      id: memberId.toHexString(),
      status: 'ACTIVE',
      updatedAt: now.toISOString(),
    });
    expect(
      await connection
        .collection('refresh_sessions')
        .findOne({ userId: memberId }),
    ).toMatchObject({ isRevoked: true });
    expect(
      await audit().findOne({ action: 'platform.user.status.changed' }),
    ).toMatchObject({
      previousStatus: 'SUSPENDED',
      newStatus: 'ACTIVE',
      requestId: 'user-reactivation-1',
      scope: 'PLATFORM',
    });
  });

  it('rejects self status changes and pending-invite reactivation without writes', async () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    await expect(
      administration.changeUserStatus({
        actorUserId: actorId.toHexString(),
        userId: actorId.toHexString(),
        status: 'SUSPENDED',
        expectedUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
        reasonCode: 'ACCESS_REVIEW',
        now,
      }),
    ).rejects.toMatchObject({
      response: { code: 'SELF_STATUS_CHANGE_FORBIDDEN' },
    });

    const pendingInviteId = new Types.ObjectId();
    const pendingInviteUpdatedAt = new Date('2026-10-04T00:00:00.000Z');
    await connection.collection('users').insertOne({
      _id: pendingInviteId,
      email: 'pending-invite@example.test',
      fullName: 'Pending Invite',
      status: 'PENDING_INVITE',
      createdAt: pendingInviteUpdatedAt,
      updatedAt: pendingInviteUpdatedAt,
    });
    await expect(
      administration.changeUserStatus({
        actorUserId: actorId.toHexString(),
        userId: pendingInviteId.toHexString(),
        status: 'ACTIVE',
        expectedUpdatedAt: pendingInviteUpdatedAt,
        reasonCode: 'ACCESS_REVIEW',
        now,
      }),
    ).rejects.toMatchObject({
      response: { code: 'USER_STATUS_TRANSITION_INVALID' },
    });

    expect(
      await connection.collection('users').findOne({ _id: actorId }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await connection.collection('users').findOne({ _id: pendingInviteId }),
    ).toMatchObject({ status: 'PENDING_INVITE' });
    expect(await audit().countDocuments()).toBe(0);
  });

  it('edits only allowed Platform user profile fields with CAS and atomic safe audit', async () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    const result = await administration.updateUserProfile({
      actorUserId: actorId.toHexString(),
      userId: memberId.toHexString(),
      fullName: 'Updated Member',
      avatarUrl: 'https://cdn.example.test/member.png',
      expectedUpdatedAt: new Date('2026-10-03T00:00:00.000Z'),
      correlationId: 'profile-edit-1',
      now,
    });

    expect(result).toMatchObject({
      id: memberId.toHexString(),
      fullName: 'Updated Member',
      avatarUrl: 'https://cdn.example.test/member.png',
      status: 'ACTIVE',
      updatedAt: now.toISOString(),
    });
    expect(
      await connection.collection('users').findOne({ _id: memberId }),
    ).toMatchObject({
      email: 'member@example.test',
      fullName: 'Updated Member',
      avatarUrl: 'https://cdn.example.test/member.png',
      passwordHash: 'member-password-secret',
    });
    const logs = await audit().find({}).toArray();
    expect(logs).toContainEqual(
      expect.objectContaining({
        action: 'platform.user.profile.updated',
        targetResource: 'USER',
        targetResourceId: memberId.toHexString(),
        actorUserId: actorId.toHexString(),
        scope: 'PLATFORM',
        requestId: 'profile-edit-1',
        changedFields: ['avatarUrl', 'fullName'],
      }),
    );
    expect(JSON.stringify(logs)).not.toContain('member-password-secret');

    const safeEvents = await new MongoPlatformAuditRepository(
      connection,
    ).listEvents({
      page: 1,
      pageSize: 10,
      action: 'platform.user.profile.updated',
      resourceType: 'USER',
      resourceId: memberId.toHexString(),
    });
    expect(safeEvents.data).toEqual([
      expect.objectContaining({
        action: 'platform.user.profile.updated',
        resourceType: 'USER',
        resourceId: memberId.toHexString(),
        changedFields: ['avatarUrl', 'fullName'],
      }),
    ]);
    expect(JSON.stringify(safeEvents)).not.toContain('password');

    await expect(
      administration.updateUserProfile({
        actorUserId: actorId.toHexString(),
        userId: memberId.toHexString(),
        fullName: 'Stale overwrite',
        expectedUpdatedAt: new Date('2026-10-03T00:00:00.000Z'),
        now,
      }),
    ).rejects.toMatchObject({ response: { code: 'USER_VERSION_STALE' } });
  });

  it('archives a user without deleting the user or memberships and revokes sessions atomically', async () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    await connection.collection('refresh_sessions').insertOne({
      userId: memberId,
      context: 'ORGANIZATION',
      organizationId,
      tokenHash: 'archive-refresh-hash-secret',
      isRevoked: false,
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    });
    const userCount = await connection.collection('users').countDocuments();
    const membershipCount = await connection
      .collection('organization_memberships')
      .countDocuments({ userId: memberId });

    const result = await administration.archiveUser({
      actorUserId: actorId.toHexString(),
      userId: memberId.toHexString(),
      expectedUpdatedAt: new Date('2026-10-03T00:00:00.000Z'),
      reasonCode: 'ACCESS_REVIEW',
      correlationId: 'archive-user-1',
      now,
    });

    expect(result).toMatchObject({
      id: memberId.toHexString(),
      status: 'SUSPENDED',
      archivedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(await connection.collection('users').countDocuments()).toBe(
      userCount,
    );
    expect(
      await connection.collection('users').findOne({ _id: memberId }),
    ).toMatchObject({
      status: 'SUSPENDED',
      archivedAt: now,
      archivedBy: actorId,
    });
    expect(
      await connection
        .collection('organization_memberships')
        .countDocuments({ userId: memberId }),
    ).toBe(membershipCount);
    expect(
      await connection
        .collection('refresh_sessions')
        .findOne({ userId: memberId }),
    ).toMatchObject({ isRevoked: true });
    expect(await audit().find({}).toArray()).toContainEqual(
      expect.objectContaining({
        action: 'platform.user.archived',
        targetResource: 'USER',
        targetResourceId: memberId.toHexString(),
        actorUserId: actorId.toHexString(),
        scope: 'PLATFORM',
        requestId: 'archive-user-1',
        reasonCode: 'ACCESS_REVIEW',
      }),
    );
    expect(JSON.stringify(await audit().find({}).toArray())).not.toContain(
      'archive-refresh-hash-secret',
    );

    const archived = await administration.listUsers({
      page: 1,
      pageSize: 10,
      status: 'ARCHIVED',
    });
    expect(archived.data.map(({ id }) => id)).toContain(memberId.toHexString());
    const suspended = await administration.listUsers({
      page: 1,
      pageSize: 10,
      status: 'SUSPENDED',
    });
    expect(suspended.data.map(({ id }) => id)).not.toContain(
      memberId.toHexString(),
    );
    await expect(
      administration.archiveUser({
        actorUserId: actorId.toHexString(),
        userId: memberId.toHexString(),
        expectedUpdatedAt: now,
        reasonCode: 'ACCESS_REVIEW',
        now,
      }),
    ).rejects.toMatchObject({ response: { code: 'USER_ALREADY_ARCHIVED' } });
  });

  it('protects self and the last Organization ADMIN from archival', async () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    await expect(
      administration.archiveUser({
        actorUserId: actorId.toHexString(),
        userId: actorId.toHexString(),
        expectedUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
        reasonCode: 'ACCESS_REVIEW',
        now,
      }),
    ).rejects.toMatchObject({ response: { code: 'SELF_ARCHIVE_FORBIDDEN' } });
    await expect(
      administration.archiveUser({
        actorUserId: actorId.toHexString(),
        userId: adminId.toHexString(),
        expectedUpdatedAt: new Date('2026-10-02T00:00:00.000Z'),
        reasonCode: 'ACCESS_REVIEW',
        now,
      }),
    ).rejects.toMatchObject({ response: { code: 'LAST_ELIGIBLE_ADMIN' } });
    expect(await audit().countDocuments()).toBe(0);
  });

  it('serializes concurrent profile writes with one successful CAS and one conflict', async () => {
    const expectedUpdatedAt = new Date('2026-10-03T00:00:00.000Z');
    const now = new Date('2026-10-16T12:00:00.000Z');
    const outcomes = await Promise.allSettled([
      administration.updateUserProfile({
        actorUserId: actorId.toHexString(),
        userId: memberId.toHexString(),
        fullName: 'Concurrent edit A',
        expectedUpdatedAt,
        correlationId: 'profile-race-a',
        now,
      }),
      administration.updateUserProfile({
        actorUserId: actorId.toHexString(),
        userId: memberId.toHexString(),
        fullName: 'Concurrent edit B',
        expectedUpdatedAt,
        correlationId: 'profile-race-b',
        now,
      }),
    ]);

    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { response: { code: 'USER_VERSION_STALE' } },
    });
    expect(
      await connection.collection('users').findOne({ _id: memberId }),
    ).toMatchObject({
      fullName: expect.stringMatching(/^Concurrent edit [AB]$/),
    });
    expect(
      await audit().countDocuments({ action: 'platform.user.profile.updated' }),
    ).toBe(1);
  });

  it('denies profile edits and archival without a current Platform assignment', async () => {
    const unauthorizedActor = new Types.ObjectId();
    const now = new Date('2026-10-16T12:00:00.000Z');
    await expect(
      administration.updateUserProfile({
        actorUserId: unauthorizedActor.toHexString(),
        userId: memberId.toHexString(),
        fullName: 'Unauthorized edit',
        expectedUpdatedAt: new Date('2026-10-03T00:00:00.000Z'),
        now,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      administration.archiveUser({
        actorUserId: unauthorizedActor.toHexString(),
        userId: memberId.toHexString(),
        expectedUpdatedAt: new Date('2026-10-03T00:00:00.000Z'),
        reasonCode: 'ACCESS_REVIEW',
        now,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(
      await connection.collection('users').findOne({ _id: memberId }),
    ).toMatchObject({
      fullName: 'Organization Member',
      status: 'ACTIVE',
    });
    expect(await audit().countDocuments()).toBe(0);
  });

  it('rolls back user profile edits when their required audit write fails', async () => {
    const writer = jest
      .spyOn(
        administration as unknown as {
          writePlatformUserProfileAudit: (...args: unknown[]) => Promise<void>;
        },
        'writePlatformUserProfileAudit',
      )
      .mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      administration.updateUserProfile({
        actorUserId: actorId.toHexString(),
        userId: memberId.toHexString(),
        fullName: 'Should roll back',
        expectedUpdatedAt: new Date('2026-10-03T00:00:00.000Z'),
        now: new Date('2026-10-16T12:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ status: 500 });
    writer.mockRestore();
    expect(
      await connection.collection('users').findOne({ _id: memberId }),
    ).toMatchObject({ fullName: 'Organization Member' });
    expect(await audit().countDocuments()).toBe(0);
  });

  it('rolls back archival and session revocation when its required audit write fails', async () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    await connection.collection('refresh_sessions').insertOne({
      userId: memberId,
      context: 'ORGANIZATION',
      organizationId,
      tokenHash: 'archive-failure-refresh-hash',
      isRevoked: false,
      expiresAt: new Date('2026-10-20T00:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    });
    const writer = jest
      .spyOn(
        administration as unknown as {
          writePlatformUserArchiveAudit: (...args: unknown[]) => Promise<void>;
        },
        'writePlatformUserArchiveAudit',
      )
      .mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      administration.archiveUser({
        actorUserId: actorId.toHexString(),
        userId: memberId.toHexString(),
        expectedUpdatedAt: new Date('2026-10-03T00:00:00.000Z'),
        reasonCode: 'ACCESS_REVIEW',
        now,
      }),
    ).rejects.toMatchObject({ status: 500 });
    writer.mockRestore();
    expect(
      await connection.collection('users').findOne({ _id: memberId }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await connection
        .collection('users')
        .findOne({ _id: memberId, archivedAt: { $exists: true } }),
    ).toBeNull();
    expect(
      await connection
        .collection('refresh_sessions')
        .findOne({ userId: memberId }),
    ).toMatchObject({ isRevoked: false });
    expect(await audit().countDocuments()).toBe(0);
  });

  it('lists safe refresh-session families and revokes one family with CAS and atomic audit', async () => {
    const firstSessionId = randomUUID();
    const otherSessionId = randomUUID();
    const older = new Date('2026-10-10T10:00:00.000Z');
    const latest = new Date('2026-10-16T10:00:00.000Z');
    const otherLatest = new Date('2026-10-16T10:01:00.000Z');
    await connection.collection('refresh_sessions').insertMany([
      {
        userId: memberId,
        sessionId: firstSessionId,
        userFence: 0,
        context: 'ORGANIZATION',
        organizationId,
        tokenHash: 'first-old-refresh-hash-secret',
        ipAddress: '203.0.113.99',
        userAgent: 'private-browser-fingerprint',
        isRevoked: true,
        expiresAt: new Date('2026-10-25T00:00:00.000Z'),
        createdAt: older,
        updatedAt: older,
      },
      {
        userId: memberId,
        sessionId: firstSessionId,
        userFence: 0,
        context: 'ORGANIZATION',
        organizationId,
        tokenHash: 'first-current-refresh-hash-secret',
        ipAddress: '203.0.113.99',
        userAgent: 'private-browser-fingerprint',
        isRevoked: false,
        expiresAt: new Date('2026-10-30T00:00:00.000Z'),
        createdAt: latest,
        updatedAt: latest,
      },
      {
        userId: memberId,
        sessionId: otherSessionId,
        userFence: 0,
        context: 'PLATFORM',
        tokenHash: 'other-refresh-hash-secret',
        isRevoked: false,
        expiresAt: new Date('2026-10-30T00:00:00.000Z'),
        createdAt: otherLatest,
        updatedAt: otherLatest,
      },
    ]);

    const sessions = await administration.listUserSessions({
      userId: memberId.toHexString(),
      page: 1,
      pageSize: 1,
      status: 'ACTIVE',
    });
    expect(sessions).toMatchObject({
      pagination: { page: 1, pageSize: 1, totalItems: 2, totalPages: 2 },
      data: [
        {
          id: expect.any(String),
          userId: memberId.toHexString(),
          context: 'PLATFORM',
          organizationId: null,
          status: 'ACTIVE',
          createdAt: otherLatest.toISOString(),
          updatedAt: otherLatest.toISOString(),
          expiresAt: '2026-10-30T00:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(sessions)).not.toContain('refresh-hash-secret');
    expect(JSON.stringify(sessions)).not.toContain('203.0.113.99');
    expect(JSON.stringify(sessions)).not.toContain(
      'private-browser-fingerprint',
    );

    const first = await administration.findUserSession(
      memberId.toHexString(),
      firstSessionId,
    );
    expect(first).toMatchObject({
      id: firstSessionId,
      context: 'ORGANIZATION',
      organizationId: organizationId.toHexString(),
      status: 'ACTIVE',
      updatedAt: latest.toISOString(),
    });
    await expect(
      administration.revokeUserSession({
        actorUserId: actorId.toHexString(),
        userId: memberId.toHexString(),
        sessionId: firstSessionId,
        expectedUpdatedAt: new Date('2026-10-15T10:00:00.000Z'),
        reasonCode: 'ACCESS_REVIEW',
        now: new Date('2026-10-16T12:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ response: { code: 'SESSION_VERSION_STALE' } });
    expect(await audit().countDocuments()).toBe(0);

    const revoked = await administration.revokeUserSession({
      actorUserId: actorId.toHexString(),
      userId: memberId.toHexString(),
      sessionId: firstSessionId,
      expectedUpdatedAt: new Date(first!.updatedAt),
      reasonCode: 'ACCESS_REVIEW',
      correlationId: 'session-revoke-001',
      now: new Date('2026-10-16T12:00:00.000Z'),
    });
    expect(revoked).toMatchObject({ id: firstSessionId, status: 'REVOKED' });
    expect(
      await connection.collection('refresh_sessions').countDocuments({
        userId: memberId,
        sessionId: firstSessionId,
        isRevoked: true,
      }),
    ).toBe(2);
    expect(
      await connection.collection('refresh_sessions').countDocuments({
        userId: memberId,
        sessionId: otherSessionId,
        isRevoked: false,
      }),
    ).toBe(1);
    expect(
      await audit().findOne({ action: 'platform.session.revoked' }),
    ).toMatchObject({
      targetResource: 'SESSION',
      targetResourceId: firstSessionId,
      actorUserId: actorId.toHexString(),
      scope: 'PLATFORM',
      result: 'SUCCESS',
      reasonCode: 'ACCESS_REVIEW',
      requestId: 'session-revoke-001',
    });
    const safeAudit = await new MongoPlatformAuditRepository(
      connection,
      AUDIT_DATABASE_NAME,
    ).listResourceHistory({
      resourceType: 'SESSION',
      resourceId: firstSessionId,
      page: 1,
      pageSize: 10,
    });
    expect(safeAudit.data).toHaveLength(1);
    expect(safeAudit.data[0]).toMatchObject({
      action: 'platform.session.revoked',
      resourceType: 'SESSION',
      resourceId: firstSessionId,
      requestId: 'session-revoke-001',
    });
    expect(JSON.stringify(safeAudit)).not.toContain('refresh-hash-secret');
  });

  it('revokes all User sessions, advances the user fence, and writes one safe event', async () => {
    const sessionIds = [randomUUID(), randomUUID()];
    await connection.collection('refresh_sessions').insertMany(
      sessionIds.map((sessionId, index) => ({
        userId: memberId,
        sessionId,
        userFence: 0,
        context: index === 0 ? 'ACCOUNT' : 'PLATFORM',
        tokenHash: `all-revoke-hash-${index}`,
        isRevoked: false,
        expiresAt: new Date('2026-10-30T00:00:00.000Z'),
        createdAt: new Date('2026-10-15T00:00:00.000Z'),
        updatedAt: new Date('2026-10-15T00:00:00.000Z'),
      })),
    );

    await expect(
      administration.revokeAllUserSessions({
        actorUserId: actorId.toHexString(),
        userId: memberId.toHexString(),
        reasonCode: 'SECURITY_INCIDENT',
        correlationId: 'session-revoke-all-001',
        now: new Date('2026-10-16T12:00:00.000Z'),
      }),
    ).resolves.toBe(2);
    expect(
      await connection.collection('users').findOne({ _id: memberId }),
    ).toMatchObject({ mutationFence: 1 });
    expect(
      await connection.collection('refresh_sessions').countDocuments({
        userId: memberId,
        isRevoked: false,
      }),
    ).toBe(0);
    const row = await audit().findOne({
      action: 'platform.sessions.revoked_all',
    });
    expect(row).toMatchObject({
      targetResource: 'USER',
      targetResourceId: memberId.toHexString(),
      actorUserId: actorId.toHexString(),
      scope: 'PLATFORM',
      result: 'SUCCESS',
      reasonCode: 'SECURITY_INCIDENT',
      requestId: 'session-revoke-all-001',
    });
    expect(JSON.stringify(row)).not.toContain('all-revoke-hash');

    const staleSessionId = randomUUID();
    await connection.collection('refresh_sessions').insertOne({
      userId: memberId,
      sessionId: staleSessionId,
      userFence: 0,
      context: 'ACCOUNT',
      tokenHash: 'late-stale-session-hash',
      isRevoked: false,
      expiresAt: new Date('2026-10-30T00:00:00.000Z'),
      createdAt: new Date('2026-10-16T12:00:01.000Z'),
      updatedAt: new Date('2026-10-16T12:00:01.000Z'),
    });
    await expect(
      administration.findUserSession(memberId.toHexString(), staleSessionId),
    ).resolves.toMatchObject({ status: 'REVOKED' });
  });

  it('atomically suspends a scoped membership, records bounded audit, and replays idempotently', async () => {
    const input = suspendInput({
      idempotencyKey: 'platform-suspend-test-0001',
    });
    const first = await commands.executePlatformSuspend(input);
    expect(first).toMatchObject({
      httpStatus: 200,
      replayed: false,
      body: {
        membership: {
          id: membershipId.toHexString(),
          organizationId: organizationId.toHexString(),
          userId: memberId.toHexString(),
          status: 'SUSPENDED',
          version: 5,
        },
      },
    });
    const replay = await commands.executePlatformSuspend(input);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(1);
    const logs = await audit().find({}).toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'ORGANIZATION_MEMBERSHIP_SUSPENDED',
      targetResource: 'ORGANIZATION_MEMBERSHIP',
      targetResourceId: membershipId.toHexString(),
      organizationId: organizationId.toHexString(),
      actorUserId: actorId.toHexString(),
      reasonCode: 'ACCESS_REVIEW',
    });
    expect(JSON.stringify(logs)).not.toContain('member@example.test');
    expect(JSON.stringify(logs)).not.toContain('password-secret');
  });

  it('denies stale, unassigned, cross-Organization, and last-admin requests without mutation', async () => {
    await expect(
      commands.executePlatformSuspend(
        suspendInput({ expectedMembershipVersion: 3 }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    await connection
      .collection('platform_authority_assignments')
      .updateOne(
        { subjectUserId: actorId, permission: platformPermission },
        { $set: { status: 'REVOKED', revokedAt: new Date() } },
      );
    await expect(
      commands.executePlatformSuspend(suspendInput()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await connection
      .collection('platform_authority_assignments')
      .updateOne(
        { subjectUserId: actorId, permission: platformPermission },
        { $set: { status: 'ACTIVE', revokedAt: null } },
      );

    await expect(
      commands.executePlatformSuspend(
        suspendInput({ organizationId: foreignOrganizationId.toHexString() }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      commands.executePlatformSuspend(
        suspendInput({
          membershipId: adminMembershipId.toHexString(),
          expectedMembershipVersion: 1,
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'LAST_ELIGIBLE_ADMIN' } });
    expect(
      await connection.collection('organization_memberships').findOne({
        _id: membershipId,
      }),
    ).toMatchObject({ status: 'ACTIVE', version: 4 });
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(await audit().countDocuments()).toBe(0);
  });

  it('rolls back membership and idempotency ledger when the required audit write fails', async () => {
    const writer = jest
      .spyOn(
        commands as unknown as {
          writeAudit: (...args: unknown[]) => Promise<void>;
        },
        'writeAudit',
      )
      .mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      commands.executePlatformSuspend(
        suspendInput({ idempotencyKey: 'platform-suspend-audit-failure' }),
      ),
    ).rejects.toMatchObject({
      status: 500,
      response: { code: 'IAM_MEMBERSHIP_MUTATION_FAILED' },
    });
    writer.mockRestore();
    expect(
      await connection.collection('organization_memberships').findOne({
        _id: membershipId,
      }),
    ).toMatchObject({ status: 'ACTIVE', version: 4 });
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(await audit().countDocuments()).toBe(0);
  });
});
