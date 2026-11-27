import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AiEngineAuthController } from './ai-engine-auth.controller';
import { AiEngineController } from './ai-engine.controller';
import type { AiEngineClient } from './ai-engine.port';
import type { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import type { AuthSecurityStore } from '../../services/iam/application/authentication/auth-security.store';
import type { IamActorContextService } from '../../services/iam/application/projects/iam-actor-context.service';
import type { ProjectService } from '../../services/iam/application/projects/project.service';

describe('AiEngineAuthController & AiEngineController security (SEC-AUTH-001 / SEC-BE-001)', () => {
  const actor = {
    id: '507f1f77bcf86cd799439011',
    email: 'member@continuum.ai',
    name: 'Test Member',
    organizationId: '507f1f77bcf86cd799439022',
    roles: ['MEMBER'],
  };
  const project = {
    id: '507f1f77bcf86cd799439033',
    organizationId: '507f1f77bcf86cd799439022',
    name: 'Confidential Core',
    code: 'CORE',
    status: 'ACTIVE' as const,
    visibility: 'PUBLIC' as const,
  };
  const validState = '550e8400-e29b-41d4-a716-446655440000';

  function buildAuthController() {
    const getCurrentIdentity = jest.fn().mockResolvedValue(actor);
    const resolveProjectActorContext = jest.fn();
    const listActiveMemberProjects = jest.fn();
    const requestMock = jest.fn();
    const store = new Map<string, string>();
    const securityStore: Partial<AuthSecurityStore> = {
      storeOneTimeToken: jest.fn((key: string, payload: string) => {
        store.set(key, payload);
        return Promise.resolve();
      }),
      consumeOneTimeToken: jest.fn((key: string) => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return Promise.resolve(value);
      }),
    };
    const config = new ConfigService({
      SAG_WEB_BASE_URL: 'https://sag.continuum.test',
      CONTINUUM_WEB_BASE_URL: 'https://app.continuum.test',
    });
    const controller = new AiEngineAuthController(
      { getCurrentIdentity } as unknown as AuthenticationApplicationService,
      { get: jest.fn(), list: jest.fn() } as unknown as ProjectService,
      config,
      { request: requestMock, requestStream: jest.fn() } as AiEngineClient,
      {
        resolveProjectActorContext,
        listActiveMemberProjects,
      } as unknown as IamActorContextService,
      securityStore as AuthSecurityStore,
    );
    const redirectMock = jest.fn<void, [number, string]>();
    const response = {
      setHeader: jest.fn(),
      redirect: redirectMock,
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    return {
      controller,
      getCurrentIdentity,
      resolveProjectActorContext,
      listActiveMemberProjects,
      requestMock,
      securityStore,
      redirectMock,
      response,
    };
  }

  it('SEC-AUTH-001: rejects SAG SSO for non-member on PUBLIC project and non-member Org ADMIN on PRIVATE project without calling SAG', async () => {
    const { controller, resolveProjectActorContext, requestMock, response } =
      buildAuthController();

    resolveProjectActorContext.mockResolvedValueOnce({
      actor,
      project,
      isProjectMember: false,
      isProjectLeader: false,
      isOrganizationAdmin: false,
    });
    await expect(
      controller.initiateSagLoginPost(
        { projectId: project.id, state: validState },
        {
          headers: { authorization: 'Bearer member' },
        } as unknown as Request,
        response,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(requestMock).not.toHaveBeenCalled();

    resolveProjectActorContext.mockResolvedValueOnce({
      actor: { ...actor, roles: ['ADMIN'] },
      project: { ...project, visibility: 'PRIVATE' as const },
      isProjectMember: false,
      isProjectLeader: false,
      isOrganizationAdmin: true,
    });
    await expect(
      controller.initiateSagLoginPost(
        { projectId: project.id, state: validState },
        {
          headers: { authorization: 'Bearer admin' },
        } as unknown as Request,
        response,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('SEC-BE-001: issues single-use opaque code (no #token=<jwt>) and exchanges it once with state binding', async () => {
    const { controller, resolveProjectActorContext, requestMock, response } =
      buildAuthController();

    resolveProjectActorContext.mockResolvedValueOnce({
      actor,
      project,
      isProjectMember: true,
      isProjectLeader: false,
      isOrganizationAdmin: false,
    });
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: { access_token: 'header.payload.sig' },
    });

    const issued = await controller.initiateSagLoginPost(
      { projectId: project.id, state: validState },
      {
        headers: { authorization: 'Bearer member' },
      } as unknown as Request,
      response,
    );

    expect(issued.code).toEqual(expect.any(String));
    expect(issued.state).toBe(validState);
    expect(issued.redirectUrl).toContain(
      `https://sag.continuum.test/sso?state=${validState}&code=`,
    );
    expect(issued.redirectUrl).not.toContain('header.payload.sig');
    expect(issued.redirectUrl).not.toContain('#token=');

    // Wrong state cannot exchange the code
    await expect(
      controller.exchangeSagCode(
        { code: issued.code, state: '111e8400-e29b-41d4-a716-446655440000' },
        response,
      ),
    ).rejects.toThrow(UnauthorizedException);

    // Re-issue and exchange once successfully, then reject replay
    resolveProjectActorContext.mockResolvedValueOnce({
      actor,
      project,
      isProjectMember: true,
      isProjectLeader: false,
      isOrganizationAdmin: false,
    });
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: { access_token: 'header.payload.sig2' },
    });
    const issued2 = await controller.initiateSagLoginPost(
      { projectId: project.id, state: validState },
      {
        headers: { authorization: 'Bearer member' },
      } as unknown as Request,
      response,
    );

    const exchanged = await controller.exchangeSagCode(
      { code: issued2.code, state: validState },
      response,
    );
    expect(exchanged).toEqual({
      accessToken: 'header.payload.sig2',
      projectId: project.id,
    });

    await expect(
      controller.exchangeSagCode(
        { code: issued2.code, state: validState },
        response,
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('SEC-BE-001: blocks cross-site GET /sag-login (Login CSRF) and never redirects raw JWT in URL fragment', async () => {
    const {
      controller,
      resolveProjectActorContext,
      requestMock,
      redirectMock,
      response,
    } = buildAuthController();

    await expect(
      controller.loginToSag(
        validState,
        project.id,
        undefined,
        'continuum_access=session',
        'cross-site',
        {
          headers: { cookie: 'continuum_access=session' },
        } as unknown as Request,
        response,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(requestMock).not.toHaveBeenCalled();

    resolveProjectActorContext.mockResolvedValueOnce({
      actor,
      project,
      isProjectMember: true,
      isProjectLeader: false,
      isOrganizationAdmin: false,
    });
    requestMock.mockResolvedValueOnce({
      status: 200,
      body: { access_token: 'header.payload.secret' },
    });

    await controller.loginToSag(
      validState,
      project.id,
      undefined,
      'continuum_access=session',
      'same-site',
      { headers: { cookie: 'continuum_access=session' } } as unknown as Request,
      response,
    );
    const redirectTarget = redirectMock.mock.calls[0]?.[1] ?? '';
    expect(redirectTarget).toContain('?state=');
    expect(redirectTarget).toContain('&code=');
    expect(redirectTarget).not.toContain('header.payload.secret');
    expect(redirectTarget).not.toContain('#token=');
  });

  it('SEC-AUTH-001: AiEngineController getDocumentStatus rejects non-members of PUBLIC projects without calling SAG', async () => {
    const getCurrentIdentity = jest.fn().mockResolvedValue(actor);
    const resolveProjectActorContext = jest.fn().mockResolvedValue({
      actor,
      project,
      isProjectMember: false,
      isProjectLeader: false,
      isOrganizationAdmin: false,
    });
    const requestMock = jest.fn();
    const controller = new AiEngineController(
      { getCurrentIdentity } as unknown as AuthenticationApplicationService,
      { get: jest.fn() } as unknown as ProjectService,
      { request: requestMock, requestStream: jest.fn() } as AiEngineClient,
      { resolveProjectActorContext } as unknown as IamActorContextService,
    );
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await expect(
      controller.getDocumentStatus(
        project.id,
        '507f1f77bcf86cd799439088',
        '1',
        'Bearer member',
        undefined,
        { headers: { authorization: 'Bearer member' } } as unknown as Request,
        response,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
