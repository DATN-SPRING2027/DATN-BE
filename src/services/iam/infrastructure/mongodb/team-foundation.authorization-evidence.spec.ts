import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { ServiceUnavailableException } from '@nestjs/common';
import { TeamAuthorizationPolicy } from '../../application/teams/team-authorization.policy';
import { TeamAuthorizationEvidence } from './team-foundation.authorization-evidence';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const organizationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const projectId = 'cccccccccccccccccccccccc';
const roleId = new Types.ObjectId('dddddddddddddddddddddddd');

function query<T>(value: T | Promise<T>) {
  const result = {
    lean: jest.fn(),
    session: jest.fn(),
    exec: jest.fn().mockImplementation(() => Promise.resolve(value)),
  };
  result.lean.mockReturnValue(result);
  result.session.mockReturnValue(result);
  return result;
}

function connectionWithCurrentProjectLeader(): Connection {
  const user = new Types.ObjectId(userId);
  const organization = new Types.ObjectId(organizationId);
  const project = new Types.ObjectId(projectId);
  return {
    models: {
      continuum_iam_projects: {
        findOne: jest.fn().mockReturnValue(
          query({
            _id: project,
            organizationId: organization,
            status: 'ACTIVE',
          }),
        ),
      },
      continuum_iam_users: {
        findOne: jest
          .fn()
          .mockReturnValue(query({ _id: user, status: 'ACTIVE' })),
      },
      continuum_iam_organization_memberships: {
        findOne: jest.fn().mockReturnValue(
          query({
            userId: user,
            organizationId: organization,
            status: 'ACTIVE',
          }),
        ),
      },
      continuum_iam_project_memberships: {
        findOne: jest.fn().mockReturnValue(
          query({
            userId: user,
            organizationId: organization,
            projectId: project,
            status: 'ACTIVE',
          }),
        ),
      },
      continuum_iam_role_assignments: {
        find: jest.fn().mockReturnValue(
          query([
            {
              _id: new Types.ObjectId('eeeeeeeeeeeeeeeeeeeeeeee'),
              organizationId: organization,
              userId: user,
              projectId: project,
              roleId,
              roleCode: 'TEAM_LEADER',
            },
          ]),
        ),
      },
      continuum_iam_roles: {
        find: jest.fn().mockReturnValue(
          query([
            {
              _id: roleId,
              code: 'TEAM_LEADER',
              permissions: ['team.read', 'team.children.manage'],
            },
          ]),
        ),
      },
    },
  } as unknown as Connection;
}

describe('TeamAuthorizationEvidence', () => {
  it('reports UNKNOWN when current IAM sources expose positive grants but no deny source', async () => {
    const evidence = new TeamAuthorizationEvidence(
      new TeamAuthorizationPolicy(),
      connectionWithCurrentProjectLeader(),
    );
    const facts = await evidence.load(organizationId, userId, projectId);
    const input = evidence.authorizationInput(
      facts,
      organizationId,
      userId,
      projectId,
      'team.read',
    );

    expect(input.assignments[0].permissions).toEqual([
      'team.read',
      'team.children.manage',
    ]);
    expect(input.explicitDeny).toBe('UNKNOWN');
    expect(new TeamAuthorizationPolicy().evaluate(input)).toEqual({
      allowed: false,
      reason: 'EXPLICIT_DENY_OR_UNKNOWN',
    });
  });

  it('does not produce authorization evidence when an authoritative parent lookup fails', async () => {
    const connection = {
      models: {
        continuum_iam_projects: {
          findOne: jest
            .fn()
            .mockReturnValue(
              query(Promise.reject(new Error('Mongo unavailable'))),
            ),
        },
      },
    } as unknown as Connection;
    const evidence = new TeamAuthorizationEvidence(
      new TeamAuthorizationPolicy(),
      connection,
    );

    const failure = await evidence.load(organizationId, userId, projectId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    if (failure instanceof ServiceUnavailableException)
      expect(failure.getResponse()).toMatchObject({
        code: 'TEAM_POLICY_NOT_READY',
      });
  });
});
