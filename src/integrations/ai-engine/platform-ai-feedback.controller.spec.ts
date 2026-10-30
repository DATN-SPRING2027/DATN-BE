import {
  BadRequestException,
  ForbiddenException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AuthorizationPolicy } from '../../services/iam/application/authorization/authorization.policy';
import { PlatformAuthorizationGuard } from '../../services/iam/application/authorization/platform-authorization.guard';
import type { AuthSecurityStore } from '../../services/iam/application/authentication/auth-security.store';
import type { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import type { AuthorizationEvidenceProvider } from '../../services/iam/application/authorization/authorization-evidence.provider';
import type { AiChatService } from './ai-chat.service';
import { PlatformAiFeedbackController } from './platform-ai-feedback.controller';

describe('PlatformAiFeedbackController', () => {
  function makeRes(): { res: Response; headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: jest.fn((key: string, value: string) => {
        headers[key.toLowerCase()] = value;
      }),
    } as unknown as Response;
    return { res, headers };
  }

  it('enforces platform.ai.operations.read via PlatformAuthorizationGuard (denying Org Manager 403, allowing System Admin 200)', async () => {
    const listPlatformFeedback = jest.fn().mockResolvedValue({
      totals: { likes: 4, dislikes: 1 },
      items: [],
      nextCursor: null,
    });
    const controller = new PlatformAiFeedbackController({
      listPlatformFeedback,
    } as unknown as AiChatService);

    const getCurrentPlatformSubject = jest
      .fn()
      .mockResolvedValue({ id: '507f1f77bcf86cd799439011', status: 'ACTIVE' });
    const loadPlatformPermission = jest.fn();
    const guard = new PlatformAuthorizationGuard(
      {
        getCurrentPlatformSubject,
      } as unknown as AuthenticationApplicationService,
      { loadPlatformPermission } as unknown as AuthorizationEvidenceProvider,
      new AuthorizationPolicy(),
      new Reflector(),
      {
        consumeRateLimit: jest.fn().mockResolvedValue(true),
      } as unknown as AuthSecurityStore,
    );

    const handler = Reflect.get(
      PlatformAiFeedbackController.prototype,
      'listFeedback',
    ) as (...args: unknown[]) => unknown;
    const makeCtx = (): ExecutionContext => {
      const { res } = makeRes();
      return {
        getHandler: () => handler,
        getClass: () => PlatformAiFeedbackController,
        switchToHttp: () => ({
          getRequest: () =>
            ({
              method: 'GET',
              headers: { authorization: 'Bearer token' },
            }) as unknown as Request,
          getResponse: () => res,
        }),
      } as unknown as ExecutionContext;
    };

    // Org Manager without PLATFORM_OPERATOR assignment -> 403 Forbidden
    loadPlatformPermission.mockResolvedValueOnce({ assignments: [] });
    await expect(guard.canActivate(makeCtx())).rejects.toThrow(
      ForbiddenException,
    );

    // System Admin with active platform.ai.operations.read assignment -> allowed
    loadPlatformPermission.mockResolvedValueOnce({
      assignments: [
        {
          subjectUserId: '507f1f77bcf86cd799439011',
          grantedBy: '507f1f77bcf86cd799439099',
          permission: 'platform.ai.operations.read',
          scope: 'PLATFORM',
          status: 'ACTIVE',
          grantedAt: new Date('2026-01-01T00:00:00Z'),
          expiresAt: null,
          revokedAt: null,
        },
      ],
    });
    await expect(guard.canActivate(makeCtx())).resolves.toBe(true);

    const { res, headers } = makeRes();
    const result = await controller.listFeedback(
      {
        organizationId: '507f1f77bcf86cd799439022',
        rating: 'DISLIKE',
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-31T00:00:00Z',
        limit: '25',
      },
      res,
    );
    expect(headers['cache-control']).toBe('no-store');
    expect(result.totals).toEqual({ likes: 4, dislikes: 1 });
    expect(listPlatformFeedback).toHaveBeenCalledWith({
      organizationId: '507f1f77bcf86cd799439022',
      rating: 'DISLIKE',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-31T00:00:00.000Z',
      limit: 25,
    });
  });

  it('rejects unknown query keys, invalid rating, non-UTC timestamps, from >= to, and out-of-range limits with 400', async () => {
    const listPlatformFeedback = jest.fn();
    const controller = new PlatformAiFeedbackController({
      listPlatformFeedback,
    } as unknown as AiChatService);
    const { res } = makeRes();

    for (const badQuery of [
      { unknownFilter: '1' },
      { rating: 'NEUTRAL' },
      { from: '2026-10-30 10:00:00' },
      {
        from: '2026-10-30T10:00:00Z',
        to: '2026-10-30T10:00:00Z',
      },
      { limit: '0' },
      { limit: '101' },
      { cursor: 'invalid space cursor' },
    ]) {
      await expect(
        controller.listFeedback(badQuery as Record<string, unknown>, res),
      ).rejects.toThrow(BadRequestException);
    }
    expect(listPlatformFeedback).not.toHaveBeenCalled();
  });
});
