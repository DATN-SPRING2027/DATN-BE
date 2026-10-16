import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { GatewayIamController } from '../src/gateway/gateway-iam.controller';
import { TEAM_FOUNDATION_REPOSITORY } from '../src/services/iam/application/teams/team.repository';
import { TeamAuthorizationPolicy } from '../src/services/iam/application/teams/team-authorization.policy';
import { TeamService } from '../src/services/iam/application/teams/team.service';
import { TeamFoundationController } from '../src/services/iam/controllers/team-foundation.controller';
import { IamModule } from '../src/services/iam/iam.module';

const teamId = 'dddddddddddddddddddddddd';
const projectId = 'cccccccccccccccccccccccc';

describe('Team Foundation runtime contract gate', () => {
  let httpApp: import('@nestjs/common').INestApplication;
  let fetchMock: jest.SpyInstance;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [GatewayIamController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) =>
              key === 'IAM_GATEWAY_SECRET'
                ? 'gateway-secret-with-at-least-thirty-two-characters'
                : key === 'IAM_SERVICE_URL'
                  ? 'http://127.0.0.1:3001'
                  : 5000,
          },
        },
      ],
    }).compile();
    httpApp = module.createNestApplication();
    configureApplication(httpApp);
    await httpApp.init();
  });

  afterAll(async () => {
    await httpApp.close();
  });

  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new globalThis.Response('{}', { status: 200 }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('does not register Team runtime controllers or providers in IAM', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      IamModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      IamModule,
    ) as unknown[];

    expect(controllers).not.toContain(TeamFoundationController);
    expect(providers).not.toContain(TeamService);
    expect(providers).not.toContain(TeamAuthorizationPolicy);
    expect(
      providers.some(
        (provider) =>
          typeof provider === 'object' &&
          provider !== null &&
          'provide' in provider &&
          provider.provide === TEAM_FOUNDATION_REPOSITORY,
      ),
    ).toBe(false);
  });

  it.each([
    ['POST', `/api/v1/iam/projects/${projectId}/teams`],
    ['PATCH', `/api/v1/iam/teams/${teamId}`],
    ['GET', `/api/v1/iam/projects/${projectId}/teams`],
    ['GET', `/api/v1/iam/teams/${teamId}`],
    ['POST', `/api/v1/iam/teams/${teamId}/archive`],
    ['POST', `/api/v1/iam/teams/${teamId}/restore`],
  ])('keeps %s %s unavailable at the Gateway', async (method, path) => {
    const client = request(httpApp.getHttpServer() as App);
    const response =
      method === 'GET'
        ? await client.get(path)
        : method === 'PATCH'
          ? await client.patch(path).send({ name: 'Unapproved Team' })
          : await client.post(path).send({ name: 'Unapproved Team' });

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
