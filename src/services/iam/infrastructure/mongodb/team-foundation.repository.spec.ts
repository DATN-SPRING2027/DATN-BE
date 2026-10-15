import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { TeamAuthorizationPolicy } from '../../application/teams/team-authorization.policy';
import { MongoTeamFoundationRepository } from './team-foundation.repository';

describe('MongoTeamFoundationRepository', () => {
  it('fails closed without creating the Team operation or audit collections', async () => {
    const iamDatabase = {
      listCollections: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
      collection: jest.fn(),
    };
    const auditDatabase = {
      listCollections: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
      collection: jest.fn(),
    };
    const connection = {
      db: iamDatabase,
      useDb: jest.fn().mockReturnValue({ db: auditDatabase }),
    };
    const repository = new MongoTeamFoundationRepository(
      new TeamAuthorizationPolicy(),
      connection as never,
    );
    const inspectReadiness = (
      repository as unknown as {
        ensureMutationReady: () => Promise<unknown>;
      }
    ).ensureMutationReady;

    await expect(inspectReadiness.call(repository)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(iamDatabase.listCollections).toHaveBeenCalledWith(
      { name: 'team_operations' },
      { nameOnly: true },
    );
    expect(auditDatabase.listCollections).toHaveBeenCalledWith(
      { name: 'audit_logs_iam' },
      { nameOnly: true },
    );
    expect(iamDatabase.collection).not.toHaveBeenCalled();
    expect(auditDatabase.collection).not.toHaveBeenCalled();
  });

  it('fails closed when a unique operation index is only partial', async () => {
    const cursor = (rows: unknown[]) => ({
      toArray: jest.fn().mockResolvedValue(rows),
    });
    const operationIndexes = {
      listIndexes: () =>
        cursor([
          {
            key: { organizationId: 1, actorUserId: 1, keyHash: 1 },
            unique: true,
            partialFilterExpression: { status: 'COMMITTED' },
          },
          {
            key: { expiresAt: 1 },
            expireAfterSeconds: 0,
          },
        ]),
    };
    const auditIndexes = {
      listIndexes: () =>
        cursor([
          {
            key: {
              organizationId: 1,
              'metadata.commandId': 1,
              action: 1,
              targetResourceId: 1,
            },
            unique: true,
            partialFilterExpression: {
              targetResource: 'TEAM',
              'metadata.commandId': { $exists: true },
            },
          },
        ]),
    };
    const teamIndexes = {
      listIndexes: () =>
        cursor([
          {
            key: { organizationId: 1, projectId: 1, code: 1 },
            unique: true,
          },
        ]),
    };
    const iamDatabase = {
      listCollections: jest
        .fn()
        .mockReturnValue(
          cursor([{ name: 'team_operations', type: 'collection' }]),
        ),
      collection: jest.fn().mockReturnValue(operationIndexes),
    };
    const auditDatabase = {
      listCollections: jest
        .fn()
        .mockReturnValue(
          cursor([{ name: 'audit_logs_iam', type: 'collection' }]),
        ),
      collection: jest.fn().mockReturnValue(auditIndexes),
    };
    const repository = new MongoTeamFoundationRepository(
      new TeamAuthorizationPolicy(),
      {
        db: iamDatabase,
        useDb: () => ({ db: auditDatabase }),
      } as never,
    );
    const internal = repository as unknown as {
      ensureMutationReady: () => Promise<unknown>;
      rawTeams: () => unknown;
    };
    internal.rawTeams = () => teamIndexes;

    await expect(
      internal.ensureMutationReady.call(repository),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('hides malformed Team records from users without Team read access', async () => {
    const organizationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const actorUserId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const projectId = 'cccccccccccccccccccccccc';
    const teamId = 'dddddddddddddddddddddddd';
    const rawTeam = {
      _id: new Types.ObjectId(teamId),
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      name: 'Legacy Team',
      code: 'LEGACY',
      status: 'INVALID_LEGACY_STATUS',
    };
    const repository = new MongoTeamFoundationRepository(
      new TeamAuthorizationPolicy(),
    );
    const internal = repository as unknown as {
      rawTeams: () => unknown;
      authorizationEvidence: {
        load: () => Promise<unknown>;
        authorizationInput: () => unknown;
        hasActiveProjectAccess: () => boolean;
      };
    };
    internal.rawTeams = () => ({ findOne: () => Promise.resolve(rawTeam) });
    internal.authorizationEvidence = {
      load: () => Promise.resolve({}),
      authorizationInput: () => ({
        permission: 'team.read',
        subject: { userId: actorUserId, organizationId, status: 'ACTIVE' },
        requestedOrganizationId: organizationId,
        requestedProjectId: projectId,
        project: { id: projectId, organizationId, status: 'ACTIVE' },
        membership: { userId: actorUserId, organizationId, status: 'ACTIVE' },
        projectMembership: {
          userId: actorUserId,
          organizationId,
          projectId,
          status: 'ACTIVE',
        },
        assignments: [],
        explicitDeny: 'CLEAR',
      }),
      hasActiveProjectAccess: () => true,
    };

    await expect(
      repository.get(organizationId, actorUserId, teamId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes Team, operation result, and audit with the same transaction session', async () => {
    const organizationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const actorUserId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const projectId = 'cccccccccccccccccccccccc';
    const session = {
      withTransaction: jest.fn(async (callback: () => Promise<void>) =>
        callback(),
      ),
      endSession: jest.fn(),
    };
    let sessionStarted = false;
    const connection = {
      startSession: jest.fn(() => {
        sessionStarted = true;
        return Promise.resolve(session);
      }),
    };
    const repository = new MongoTeamFoundationRepository(
      new TeamAuthorizationPolicy(),
      connection as never,
    );
    const teamCollection = { insertOne: jest.fn().mockResolvedValue({}) };
    let storedUpdate: Record<string, unknown> | undefined;
    let storedOperation:
      | {
          organizationId: Types.ObjectId;
          actorUserId: Types.ObjectId;
        }
      | undefined;
    const operations = {
      findOne: jest.fn().mockResolvedValue(null),
      insertOne: jest.fn(
        (document: {
          organizationId: Types.ObjectId;
          actorUserId: Types.ObjectId;
        }) => {
          storedOperation = document;
          return Promise.resolve({});
        },
      ),
      updateOne: jest.fn(
        (_filter: Record<string, unknown>, update: Record<string, unknown>) => {
          storedUpdate = update;
          return Promise.resolve({ modifiedCount: 1 });
        },
      ),
    };
    let storedAudit: Record<string, unknown> | undefined;
    const audit = {
      insertOne: jest.fn((event: Record<string, unknown>) => {
        storedAudit = event;
        return Promise.resolve({});
      }),
    };
    const objectId = (value: string) => new Types.ObjectId(value);
    const facts = {
      user: { _id: objectId(actorUserId), status: 'ACTIVE' },
      organizationMembership: {
        _id: objectId('eeeeeeeeeeeeeeeeeeeeeeee'),
        userId: objectId(actorUserId),
        organizationId: objectId(organizationId),
        status: 'ACTIVE',
      },
      project: {
        _id: objectId(projectId),
        organizationId: objectId(organizationId),
        status: 'ACTIVE',
      },
      projectMembership: {
        _id: objectId('ffffffffffffffffffffffff'),
        userId: objectId(actorUserId),
        organizationId: objectId(organizationId),
        projectId: objectId(projectId),
        status: 'ACTIVE',
      },
      assignments: [
        {
          document: {
            _id: objectId('111111111111111111111111'),
            organizationId: objectId(organizationId),
            userId: objectId(actorUserId),
            roleId: objectId('222222222222222222222222'),
            roleCode: 'TEAM_LEADER',
            projectId: objectId(projectId),
          },
          role: {
            _id: objectId('222222222222222222222222'),
            code: 'TEAM_LEADER',
            permissions: ['team:children.manage'],
          },
          evidence: {
            userId: actorUserId,
            organizationId,
            projectId,
            roleCode: 'TEAM_LEADER',
            resolvedRoleCode: 'TEAM_LEADER',
            permissions: ['team:children.manage'],
          },
        },
      ],
    };
    const internal = repository as unknown as {
      ensureMutationReady: (...args: unknown[]) => Promise<unknown>;
      authorizationEvidence: {
        load: () => Promise<unknown>;
        authorizationInput: (
          facts: unknown,
          organizationId: string,
          actorUserId: string,
          projectId: string,
          permission: string,
        ) => unknown;
        hasActiveProjectAccess: () => boolean;
        fenceAuthorization: () => Promise<void>;
      };
      rawTeams: () => unknown;
    };
    internal.authorizationEvidence = {
      load: () => Promise.resolve(facts),
      authorizationInput: (
        _facts,
        organizationId,
        actorUserId,
        projectId,
        permission,
      ) => ({
        permission,
        subject: { userId: actorUserId, organizationId, status: 'ACTIVE' },
        requestedOrganizationId: organizationId,
        requestedProjectId: projectId,
        project: { id: projectId, organizationId, status: 'ACTIVE' },
        membership: { userId: actorUserId, organizationId, status: 'ACTIVE' },
        projectMembership: {
          userId: actorUserId,
          organizationId,
          projectId,
          status: 'ACTIVE',
        },
        assignments: facts.assignments.map((assignment) => assignment.evidence),
        explicitDeny: 'CLEAR',
      }),
      hasActiveProjectAccess: () => true,
      fenceAuthorization: () => Promise.resolve(),
    };
    internal.ensureMutationReady = jest.fn(() => {
      expect(sessionStarted).toBe(false);
      return Promise.resolve({ operations, audit });
    });
    internal.rawTeams = () => teamCollection;

    const result = await repository.create(
      organizationId,
      actorUserId,
      projectId,
      { name: 'Operations', code: 'OPS', description: null },
      'create:1',
    );

    expect(result.statusCode).toBe(201);
    expect(result.team).toMatchObject({
      organizationId,
      projectId,
      name: 'Operations',
      code: 'OPS',
      status: 'ACTIVE',
      version: 1,
    });
    expect(teamCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ACTIVE', version: 1 }),
      { session },
    );
    expect(operations.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'IN_PROGRESS' }),
      { session },
    );
    expect(storedOperation?.organizationId).toEqual(objectId(organizationId));
    expect(storedOperation?.actorUserId).toEqual(objectId(actorUserId));
    expect(storedAudit).toMatchObject({
      action: 'team.create',
      targetResource: 'TEAM',
      targetResourceId: result.team.id,
      metadata: {
        teamId: result.team.id,
        oldVersion: null,
        newVersion: 1,
        changedFields: ['name', 'code', 'description', 'status'],
      },
    });
    expect(audit.insertOne).toHaveBeenCalledWith(expect.any(Object), {
      session,
    });
    expect(operations.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      { session },
    );
    expect(storedUpdate?.$set).toMatchObject({
      status: 'COMMITTED',
      httpStatus: 201,
    });
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalledTimes(1);
    expect(internal.ensureMutationReady).toHaveBeenCalledTimes(1);
  });
});
