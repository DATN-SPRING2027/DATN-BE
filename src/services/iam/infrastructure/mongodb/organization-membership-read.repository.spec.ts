import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mongo, Types, type Connection, type PipelineStage } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../../../../bootstrap';
import { AuthenticationApplicationService } from '../../application/authentication/authentication.application.service';
import { ORGANIZATION_MEMBERSHIP_READ_REPOSITORY } from '../../application/organizations/organization-membership-read.repository';
import { OrganizationMembershipReadService } from '../../application/organizations/organization-membership-read.service';
import { OrganizationMembershipReadController } from '../../controllers/organization-membership-read.controller';
import { MongoOrganizationMembershipReadRepository } from './organization-membership-read.repository';

describe('Membership read persistence failures over HTTP', () => {
  const organizationId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const membershipId = new Types.ObjectId();
  const url = `/api/v1/iam/organizations/${String(organizationId)}/memberships`;
  let app: INestApplication;
  let email: string;
  const userExec = jest.fn();
  const memberExec = jest.fn<Promise<unknown[]>, [boolean]>();
  function aggregate(exec: jest.Mock) {
    const query = { option: jest.fn().mockReturnThis(), exec };
    return jest.fn().mockReturnValue(query);
  }
  const users = aggregate(userExec);
  const members = jest.fn();
  const connection = {
    readyState: 1,
    models: {
      continuum_iam_users: { aggregate: users },
      continuum_iam_organization_memberships: { aggregate: members },
    },
  };
  function row() {
    return {
      _id: membershipId,
      organizationId,
      userId,
      status: 'ACTIVE',
      version: 1,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      user: { _id: userId, email, fullName: 'Member', status: 'ACTIVE' },
      organizationRoleAssignments: [],
    };
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OrganizationMembershipReadController],
      providers: [
        OrganizationMembershipReadService,
        {
          provide: AuthenticationApplicationService,
          useValue: {
            getCurrentIdentity: () => ({
              id: String(userId),
              organizationId: String(organizationId),
            }),
          },
        },
        {
          provide: ORGANIZATION_MEMBERSHIP_READ_REPOSITORY,
          useValue: new MongoOrganizationMembershipReadRepository(
            connection as unknown as Connection,
          ),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    connection.readyState = 1;
    email = 'member@example.test';
    userExec.mockResolvedValue([
      { assignments: [{ permissions: ['organization.memberships.read'] }] },
    ]);
    memberExec.mockImplementation((list: boolean) =>
      Promise.resolve(
        list ? [{ data: [row()], total: [{ count: 1 }] }] : [row()],
      ),
    );
    members.mockImplementation((pipeline: PipelineStage[]) => ({
      option: jest.fn().mockReturnThis(),
      exec: () => memberExec(pipeline.some((stage) => '$facet' in stage)),
    }));
  });
  function get(detail: boolean) {
    return request(app.getHttpServer() as App)
      .get(detail ? `${url}/${String(membershipId)}` : url)
      .set('Authorization', 'Bearer fixture');
  }
  it('returns an unassigned Organization role as null at version zero', async () => {
    memberExec.mockImplementation((list: boolean) =>
      Promise.resolve(list ? [{ data: [row()], total: [{ count: 1 }] }] : []),
    );
    const response = await get(false).expect(200);
    const responseBody = response.body as { data: Record<string, unknown>[] };
    expect(responseBody.data[0]).toMatchObject({
      roleCode: null,
      roleVersion: 0,
    });
  });
  it('returns the Organization role code and mutation fence for the membership row', async () => {
    const roleId = new Types.ObjectId();
    memberExec.mockImplementation((list: boolean) =>
      Promise.resolve(
        list
          ? [
              {
                data: [
                  {
                    ...row(),
                    organizationRoleAssignments: [
                      {
                        roleId,
                        roleCode: 'MEMBER',
                        catalogRoleCode: 'MEMBER',
                        mutationFence: 4,
                      },
                    ],
                  },
                ],
                total: [{ count: 1 }],
              },
            ]
          : [],
      ),
    );
    const response = await get(false).expect(200);
    const responseBody = response.body as { data: Record<string, unknown>[] };
    expect(responseBody.data[0]).toMatchObject({
      roleCode: 'MEMBER',
      roleVersion: 4,
    });
  });
  it('fails closed when an assigned Organization role has no migrated fence', async () => {
    const roleId = new Types.ObjectId();
    memberExec.mockImplementation((list: boolean) =>
      Promise.resolve(
        list
          ? [
              {
                data: [
                  {
                    ...row(),
                    organizationRoleAssignments: [
                      {
                        roleId,
                        roleCode: 'MEMBER',
                        catalogRoleCode: 'MEMBER',
                      },
                    ],
                  },
                ],
                total: [{ count: 1 }],
              },
            ]
          : [],
      ),
    );
    unavailable(await get(false).expect(503));
  });
  it('fails closed when Organization role data is ambiguous or does not match catalog', async () => {
    memberExec.mockImplementation((list: boolean) =>
      Promise.resolve(
        list
          ? [
              {
                data: [
                  {
                    ...row(),
                    organizationRoleAssignments: [
                      {
                        roleId: new Types.ObjectId(),
                        roleCode: 'MEMBER',
                        catalogRoleCode: 'ADMIN',
                        mutationFence: 0,
                      },
                    ],
                  },
                ],
                total: [{ count: 1 }],
              },
            ]
          : [],
      ),
    );
    await get(false).expect(503);
  });
  function unavailable(response: {
    body: unknown;
    headers: Record<string, unknown>;
  }) {
    expect(response.body).toMatchObject({
      code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      details: {},
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain('private');
  }
  describe.each([false, true])('detail=%s', (detail) => {
    it.each([
      '',
      'not-an-email',
      'member@',
      'member@example..test',
      ' private@example.test ',
    ])(
      'rejects malformed stored email %j with a sanitized 503',
      async (value) => {
        email = value;
        unavailable(await get(detail).expect(503));
      },
    );
    it.each(['member@example.test', 'Mixed.Case+tag@sub.example.test'])(
      'keeps valid stored email %s unchanged',
      async (value) => {
        email = value;
        const response = await get(detail).expect(200);
        expect(JSON.stringify(response.body)).toContain(value);
      },
    );
  });
  describe.each(['authority', 'list', 'detail'] as const)(
    '%s aggregation',
    (operation) => {
      const failures = [
        new mongo.MongoNetworkError('private connection information'),
        new mongo.MongoNetworkTimeoutError('private socket timeout'),
        new mongo.MongoOperationTimeoutError('private operation timeout'),
        new mongo.MongoNotConnectedError('private disconnected client'),
        new mongo.MongoClientClosedError(),
        new mongo.MongoServerClosedError('private closed server'),
        new mongo.MongoTopologyClosedError('private closed topology'),
        new mongo.MongoServerError({
          message: 'private query deadline',
          code: 50,
        }),
        // Inject the driver's class without depending on its internal topology constructor.
        Object.assign(
          Object.create(mongo.MongoServerSelectionError.prototype) as Error,
          {
            message: 'private server selection timeout',
          },
        ),
      ];
      it.each(failures)(
        'maps %s to sanitized dependency 503',
        async (error) => {
          (operation === 'authority' ? userExec : memberExec).mockRejectedValue(
            error,
          );
          unavailable(await get(operation === 'detail').expect(503));
          if (operation === 'authority') expect(members).not.toHaveBeenCalled();
        },
      );
      it.each([
        new Error('private programming failure'),
        new mongo.MongoServerError({
          message: 'private malformed query',
          code: 2,
        }),
      ])('keeps unexpected %s as sanitized 500', async (error) => {
        (operation === 'authority' ? userExec : memberExec).mockRejectedValue(
          error,
        );
        const response = await get(operation === 'detail').expect(500);
        expect(response.body).toMatchObject({ code: 'HTTP_500', details: {} });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(response.body)).not.toContain('private');
      });
    },
  );
  it('fails before querying when the registered connection is not ready', async () => {
    connection.readyState = 0;
    unavailable(await get(false).expect(503));
    expect(users).not.toHaveBeenCalled();
  });
});
