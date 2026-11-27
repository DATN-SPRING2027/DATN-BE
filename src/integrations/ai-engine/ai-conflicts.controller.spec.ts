import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AiConflictsController } from './ai-conflicts.controller';
import type { AiEngineClient } from './ai-engine.port';
import type { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import type {
  IamActorContextService,
  IamProjectActorContext,
} from '../../services/iam/application/projects/iam-actor-context.service';

const ORG_ID = '507f1f77bcf86cd799439011';
const PROJECT_ID = '507f1f77bcf86cd799439022';
const USER_ID = '507f1f77bcf86cd799439033';

function makeScope(
  overrides: Partial<IamProjectActorContext> = {},
): IamProjectActorContext {
  return {
    actor: {
      id: USER_ID,
      email: 'leader@continuum.local',
      name: 'Leader',
      organizationId: ORG_ID,
      roles: ['MEMBER'],
    },
    project: {
      id: PROJECT_ID,
      organizationId: ORG_ID,
      name: 'Alpha',
      code: 'ALP',
      status: 'ACTIVE',
      visibility: 'PRIVATE',
    },
    isProjectMember: true,
    isLeader: true,
    isManager: false,
    joinedAt: '2026-01-01T00:00:00.000Z',
    canReview: true,
    ...overrides,
  };
}

function makeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  return {
    res: {
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
      status: (code: number) => {
        statusCode = code;
      },
    } as unknown as Response,
    getStatus: () => statusCode,
    headers,
  };
}

describe('AiConflictsController (Continuum BFF reviewer authorization)', () => {
  const getCurrentIdentityMock = jest.fn();
  const resolveProjectActorContextMock = jest.fn();
  const requestMock = jest.fn();

  const auth = {
    getCurrentIdentity: getCurrentIdentityMock,
  } as unknown as AuthenticationApplicationService;
  const actorContext = {
    resolveProjectActorContext: resolveProjectActorContextMock,
  } as unknown as IamActorContextService;
  const aiEngine = {
    request: requestMock,
  } as unknown as AiEngineClient;

  let controller: AiConflictsController;

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new AiConflictsController(auth, aiEngine, actorContext);
  });

  it('allows an active Project Leader to resolve a conflict and asserts server-derived reviewer headers', async () => {
    const scope = makeScope({ isLeader: true, canReview: true });
    getCurrentIdentityMock.mockResolvedValue(scope.actor);
    resolveProjectActorContextMock.mockResolvedValue(scope);
    requestMock.mockResolvedValue({
      status: 200,
      body: { id: 'res-1', status: 'ACTIVE' },
    });

    const { res, getStatus } = makeResponse();
    const result = await controller.resolveConflict(
      PROJECT_ID,
      'res-1',
      { action: 'WINNER_B', reason: 'Verified v2 runbook' },
      'Bearer session-jwt',
      undefined,
      {
        headers: {
          'x-continuum-role': 'SPOOFED_ADMIN',
          'x-sag-bff-service-token': 'spoofed-secret',
        },
      } as unknown as Request,
      res,
    );

    expect(getStatus()).toBe(200);
    expect(result).toEqual({ id: 'res-1', status: 'ACTIVE' });
    expect(requestMock).toHaveBeenCalledWith({
      path: `/api/v1/projects/${PROJECT_ID}/conflicts/res-1/resolve`,
      method: 'POST',
      headers: {
        'X-Continuum-User-Id': USER_ID,
        'X-Continuum-Organization-Id': ORG_ID,
        'X-Continuum-Tenant-Id': ORG_ID,
        'X-Continuum-Project-Id': PROJECT_ID,
        'X-Continuum-Security-Partition': PROJECT_ID,
        'X-Continuum-Role': 'LEADER',
        'X-Continuum-Capabilities': 'conflict.resolve,knowledge.verify',
      },
      body: { action: 'WINNER_B', reason: 'Verified v2 runbook' },
    });
  });

  it('allows an active Organization Manager project member to reopen a conflict with ADMIN role header', async () => {
    const scope = makeScope({
      isLeader: false,
      isManager: true,
      canReview: true,
    });
    getCurrentIdentityMock.mockResolvedValue(scope.actor);
    resolveProjectActorContextMock.mockResolvedValue(scope);
    requestMock.mockResolvedValue({
      status: 200,
      body: { id: 'res-1', status: 'PENDING_REVIEW' },
    });

    const { res } = makeResponse();
    await controller.reopenConflict(
      PROJECT_ID,
      'res-1',
      { reason: 'Needs further review' },
      'Bearer session-jwt',
      undefined,
      { headers: {} } as unknown as Request,
      res,
    );

    expect(requestMock).toHaveBeenCalledWith({
      path: `/api/v1/projects/${PROJECT_ID}/conflicts/res-1/reopen`,
      method: 'POST',
      headers: {
        'X-Continuum-User-Id': USER_ID,
        'X-Continuum-Organization-Id': ORG_ID,
        'X-Continuum-Tenant-Id': ORG_ID,
        'X-Continuum-Project-Id': PROJECT_ID,
        'X-Continuum-Security-Partition': PROJECT_ID,
        'X-Continuum-Role': 'ADMIN',
        'X-Continuum-Capabilities': 'conflict.resolve,knowledge.verify',
      },
      body: { reason: 'Needs further review' },
    });
  });

  it('rejects a regular project MEMBER (canReview: false) with 403 and never calls SAG', async () => {
    const scope = makeScope({
      isLeader: false,
      isManager: false,
      canReview: false,
    });
    getCurrentIdentityMock.mockResolvedValue(scope.actor);
    resolveProjectActorContextMock.mockResolvedValue(scope);

    const { res } = makeResponse();
    await expect(
      controller.resolveConflict(
        PROJECT_ID,
        'res-1',
        { action: 'WINNER_A' },
        'Bearer member-jwt',
        undefined,
        { headers: {} } as unknown as Request,
        res,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects a non-member with 404 PROJECT_NOT_FOUND and rejects malformed resolutionId with 400', async () => {
    const scope = makeScope({ isProjectMember: false, canReview: true });
    getCurrentIdentityMock.mockResolvedValue(scope.actor);
    resolveProjectActorContextMock.mockResolvedValue(scope);

    const { res } = makeResponse();
    await expect(
      controller.resolveConflict(
        PROJECT_ID,
        'res-1',
        { action: 'WINNER_A' },
        'Bearer outsider-jwt',
        undefined,
        { headers: {} } as unknown as Request,
        res,
      ),
    ).rejects.toThrow(NotFoundException);

    await expect(
      controller.resolveConflict(
        PROJECT_ID,
        '../evil',
        { action: 'WINNER_A' },
        'Bearer leader-jwt',
        undefined,
        { headers: {} } as unknown as Request,
        res,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
