import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { TeamAuthorizationPolicy } from '../../application/teams/team-authorization.policy';
import { MongoTeamFoundationRepository } from './team-foundation.repository';

describe('MongoTeamFoundationRepository', () => {
  it('keeps mutation disabled before persistence even when storage is present', async () => {
    const database = {
      listCollections: jest.fn().mockReturnValue({
        toArray: jest
          .fn()
          .mockResolvedValue([{ name: 'team_operations', type: 'collection' }]),
      }),
      collection: jest.fn(),
    };
    const session = { withTransaction: jest.fn(), endSession: jest.fn() };
    const connection = {
      db: database,
      startSession: jest.fn().mockResolvedValue(session),
      useDb: jest.fn(),
    };
    const repository = new MongoTeamFoundationRepository(
      new TeamAuthorizationPolicy(),
      connection as never,
    );
    const internal = repository as unknown as {
      authorizeMutation: jest.Mock;
    };
    internal.authorizeMutation = jest.fn().mockResolvedValue({});

    await expect(
      repository.create(
        'bbbbbbbbbbbbbbbbbbbbbbbb',
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        'cccccccccccccccccccccccc',
        { name: 'Operations', code: 'OPS', description: null },
        'create:1',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(database.listCollections).not.toHaveBeenCalled();
    expect(database.collection).not.toHaveBeenCalled();
    expect(connection.useDb).not.toHaveBeenCalled();
    expect(connection.startSession).not.toHaveBeenCalled();
    expect(session.withTransaction).not.toHaveBeenCalled();
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
});
