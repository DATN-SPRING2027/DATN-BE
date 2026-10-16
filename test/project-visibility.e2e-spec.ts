import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { ProjectAccessController } from '../src/services/iam/controllers/project-access.controller';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import { ProjectAccessService } from '../src/services/iam/application/projects/project-access.service';
import {
  AUTHORIZATION_EVIDENCE_PROVIDER,
  type ProjectAccessEvidence,
} from '../src/services/iam/application/authorization/authorization-evidence.provider';
import { AuthorizationPolicy } from '../src/services/iam/application/authorization/authorization.policy';
import { ProjectAccessAuthorizationGuard } from '../src/services/iam/application/authorization/project-access-authorization.guard';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const organizationId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const projectId = 'cccccccccccccccccccccccc';
const path = `/api/v1/iam/projects/${projectId}/visibility`;
const actor = {
  id: userId,
  organizationId,
  email: 'admin@example.test',
  name: 'Admin',
  roles: ['ADMIN'],
};
function facts(): ProjectAccessEvidence {
  return {
    project: {
      id: projectId,
      organizationId,
      status: 'ACTIVE',
      visibility: 'PRIVATE',
    },
    membership: { userId, organizationId, status: 'ACTIVE' },
    projectMembership: null,
    assignments: [
      {
        userId,
        organizationId,
        projectId: null,
        roleCode: 'ADMIN',
        resolvedRoleCode: 'ADMIN',
        permissions: ['project.visibility.manage'],
      },
    ],
    explicitDeny: 'CLEAR',
  };
}
describe('Project visibility HTTP contract', () => {
  let app: INestApplication;
  let evidence: ProjectAccessEvidence;
  const auth = { getCurrentIdentity: jest.fn() };
  const access = { changeVisibility: jest.fn() };
  beforeEach(async () => {
    evidence = facts();
    auth.getCurrentIdentity.mockReset().mockResolvedValue(actor);
    access.changeVisibility
      .mockReset()
      .mockImplementation((_actor, _id, visibility: 'PRIVATE' | 'PUBLIC') =>
        Promise.resolve({
          id: projectId,
          organizationId,
          visibility,
        }),
      );
    const module = await Test.createTestingModule({
      controllers: [ProjectAccessController],
      providers: [
        ProjectAccessAuthorizationGuard,
        AuthorizationPolicy,
        { provide: AuthenticationApplicationService, useValue: auth },
        { provide: ProjectAccessService, useValue: access },
        {
          provide: AUTHORIZATION_EVIDENCE_PROVIDER,
          useValue: { loadProjectAccess: () => Promise.resolve(evidence) },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  it('returns a no-store read-only allow signal without Project membership or mutation', async () => {
    const response = await request(app.getHttpServer() as App)
      .get(path)
      .expect(200);
    expect(response.body).toEqual({ canManageVisibility: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(access.changeVisibility).not.toHaveBeenCalled();
  });
  it('denies an ADMIN label when current Role permissions do not grant the action', async () => {
    evidence.assignments = [{ ...evidence.assignments[0], permissions: [] }];
    await request(app.getHttpServer() as App)
      .get(path)
      .expect(403);
    expect(access.changeVisibility).not.toHaveBeenCalled();
  });
  it('does not expose nested Project memberships to a PUBLIC metadata reader', async () => {
    evidence.project!.visibility = 'PUBLIC';
    evidence.assignments = [];
    await request(app.getHttpServer() as App)
      .get(`/api/v1/iam/projects/${projectId}/memberships`)
      .expect(403);
    expect(access.changeVisibility).not.toHaveBeenCalled();
  });
  it('reauthorizes a mutation after a prior allow signal', async () => {
    await request(app.getHttpServer() as App)
      .get(path)
      .expect(200);
    evidence.membership!.status = 'INACTIVE';
    await request(app.getHttpServer() as App)
      .patch(path)
      .send({ visibility: 'PUBLIC' })
      .expect(403);
    expect(access.changeVisibility).not.toHaveBeenCalled();
  });
  it.each(['PRIVATE', 'PUBLIC'])(
    'forwards an authorized %s mutation',
    async (visibility) => {
      await request(app.getHttpServer() as App)
        .patch(path)
        .send({ visibility })
        .expect(200);
      expect(access.changeVisibility).toHaveBeenCalledWith(
        actor,
        projectId,
        visibility,
      );
    },
  );
  it('rejects cross-organization selectors', async () => {
    await request(app.getHttpServer() as App)
      .get(path)
      .query({ organizationId: 'dddddddddddddddddddddddd' })
      .expect(404);
    expect(access.changeVisibility).not.toHaveBeenCalled();
  });
  it('denies archived Projects and expired sessions', async () => {
    evidence.project!.status = 'ARCHIVED';
    await request(app.getHttpServer() as App)
      .get(path)
      .expect(403);
    auth.getCurrentIdentity.mockRejectedValue(new UnauthorizedException());
    await request(app.getHttpServer() as App)
      .get(path)
      .expect(401);
  });
});
