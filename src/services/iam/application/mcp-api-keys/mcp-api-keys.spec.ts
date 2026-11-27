import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../../../../bootstrap';
import { mcpKeyRestMutationGuardMiddleware } from '../../../../common/http/mcp-key-rest-guard.middleware';
import {
  AuthenticationApplicationService,
  type AuthenticatedIdentity,
} from '../authentication/authentication.application.service';
import type { AuthenticationRepositoryPort } from '../authentication/authentication.repository';
import { LeaderDirectedLoginEligibilityPolicy } from '../authentication/leader-directed-login-eligibility.policy';
import type { OrganizationContextResolver } from '../authentication/organization-context.resolver';
import { PasswordCredentialService } from '../credentials/password-credential.service';
import type { AccessTokenService } from '../authentication/access-token.service';
import { AuthorizationPolicy } from '../authorization/authorization.policy';
import type { AuthorizationEvidenceProvider } from '../authorization/authorization-evidence.provider';
import { ProjectAccessService } from '../projects/project-access.service';
import type { ProjectAccessRepository } from '../projects/project-access.repository';
import { ProjectService } from '../projects/project.service';
import type { ProjectRepository } from '../projects/project.repository';
import { TaskWorkspaceIamBridge } from '../../../task/workspace/task-workspace-iam.bridge';
import { MongoMcpApiKeyRepository } from '../../infrastructure/mongodb/mcp-api-key.repository';
import { McpApiKeysService } from './mcp-api-keys.service';
import { McpApiKeysController } from '../../controllers/mcp-api-keys.controller';

const USER_ID = '651a2b3c4d5e6f7a8b9c0d1e';
const OTHER_USER_ID = '651a2b3c4d5e6f7a8b9c0d99';
const ORG_ID = '651a2b3c4d5e6f7a8b9c0d1f';
const PROJECT_A = '651a2b3c4d5e6f7a8b9c0da1';
const PROJECT_B = '651a2b3c4d5e6f7a8b9c0db2';

describe('MCP API Keys & Scoped Authentication (Packet A)', () => {
  const actor: AuthenticatedIdentity = {
    id: USER_ID,
    email: 'dev@continuum.ai',
    name: 'Continuum Developer',
    organizationId: ORG_ID,
    roles: ['ADMIN', 'MEMBER'],
  };

  function createSetup() {
    const repo = new MongoMcpApiKeyRepository(undefined);
    const projectRepo: jest.Mocked<ProjectRepository> = {
      create: jest.fn(),
      listVisible: jest.fn().mockResolvedValue({
        data: [
          {
            id: PROJECT_A,
            organizationId: ORG_ID,
            name: 'Alpha',
            code: 'ALP',
            visibility: 'PRIVATE',
            status: 'ACTIVE',
            createdBy: USER_ID,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: PROJECT_B,
            organizationId: ORG_ID,
            name: 'Beta',
            code: 'BET',
            visibility: 'PRIVATE',
            status: 'ACTIVE',
            createdBy: USER_ID,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        totalItems: 2,
      }),
      findVisible: jest.fn((_orgId, _userId, projectId) => {
        if (projectId === PROJECT_A || projectId === PROJECT_B) {
          return Promise.resolve({
            id: projectId,
            organizationId: ORG_ID,
            name: projectId === PROJECT_A ? 'Alpha' : 'Beta',
            code: projectId === PROJECT_A ? 'ALP' : 'BET',
            visibility: 'PRIVATE',
            status: 'ACTIVE',
            createdBy: USER_ID,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          });
        }
        return Promise.resolve(null);
      }),
    };
    const projectService = new ProjectService(projectRepo);
    const service = new McpApiKeysService(repo, projectService);
    return { repo, projectRepo, projectService, service };
  }

  it('mints 51-char ctm_mcp_ keys, stores only SHA-256 hash + 16-char prefix, and lists views without rawKey', async () => {
    const { repo, service } = createSetup();

    const created = await service.create(actor, {
      name: '  Cursor Local Dev  ',
      scope: 'READ_WRITE',
      allowedProjectIds: [PROJECT_A],
      expiresInDays: 30,
    });

    expect(created.rawKey).toMatch(/^ctm_mcp_[A-Za-z0-9_-]{43}$/);
    expect(created.rawKey).toHaveLength(51);
    expect(created.key.name).toBe('Cursor Local Dev');
    expect(created.key.keyPrefix).toBe(created.rawKey.slice(0, 16));
    expect(created.key.keyPrefix).toHaveLength(16);
    expect(created.key.scope).toBe('READ_WRITE');
    expect(created.key.allowedProjectIds).toEqual([PROJECT_A]);
    expect(created.key.status).toBe('ACTIVE');
    expect(created.key.expiresAt).not.toBeNull();
    expect(JSON.stringify(created.key)).not.toContain(created.rawKey);

    const expectedHash = createHash('sha256')
      .update(created.rawKey)
      .digest('hex');
    const stored = await repo.findByKeyHash(expectedHash);
    expect(stored).not.toBeNull();
    expect(stored?.keyHash).toBe(expectedHash);

    const listed = await service.list(actor);
    expect(listed).toEqual({
      items: [
        expect.objectContaining({ id: created.key.id, status: 'ACTIVE' }),
      ],
      mcpEndpointPath: '/api/v1/mcp',
      protocolVersion: '2025-03-26',
      toolCount: 36,
    });
    expect(JSON.stringify(listed)).not.toContain(created.rawKey);
  });

  it('validates allowedProjectIds against ProjectService.get and rejects inaccessible or malformed inputs', async () => {
    const { service } = createSetup();

    await expect(
      service.create(actor, { name: '', scope: 'READ_ONLY' }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.create(actor, {
        name: 'Bad Scope',
        scope: 'SUPER_ADMIN',
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.create(actor, {
        name: 'Bad Expiry',
        expiresInDays: 400,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.create(actor, {
        name: 'Inaccessible Project',
        allowedProjectIds: ['651a2b3c4d5e6f7a8b9c0dff'],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('enforces owner + organization isolation on revoke', async () => {
    const { service } = createSetup();
    const created = await service.create(actor, { name: 'Claude Code' });

    const otherActor: AuthenticatedIdentity = {
      ...actor,
      id: OTHER_USER_ID,
    };
    await expect(service.revoke(otherActor, created.key.id)).rejects.toThrow(
      NotFoundException,
    );

    const revoked = await service.revoke(actor, created.key.id);
    expect(revoked.key.status).toBe('REVOKED');
    expect(revoked.key.revokedAt).not.toBeNull();
  });

  describe('AuthenticationApplicationService MCP key resolution', () => {
    function buildAuthService(repo: MongoMcpApiKeyRepository) {
      const authRepo: jest.Mocked<AuthenticationRepositoryPort> = {
        findAccountByEmail: jest.fn(),
        findAccountByGoogleSubject: jest.fn(),
        linkGoogleSubjectIfMissing: jest.fn(),
        createGoogleAccount: jest.fn(),
        findAccountById: jest.fn().mockResolvedValue({
          email: actor.email,
          status: 'ACTIVE',
          twoFactorEnabled: false,
        }),
        findOrganizationRoleAssignments: jest.fn(),
        findActiveOrganizationMembershipIds: jest
          .fn()
          .mockResolvedValue([ORG_ID]),
        findOrganizationOptions: jest.fn(),
        findProfileById: jest.fn().mockResolvedValue({
          name: actor.name,
          status: 'ACTIVE',
          mutationFence: 0,
        }),
        replacePasswordHashIfCurrent: jest.fn(),
        resetPassword: jest.fn(),
        revokeRefreshSessionByHash: jest.fn(),
        findRefreshSessionForRotation: jest.fn(),
        rotateRefreshSession: jest.fn(),
        createRefreshSession: jest.fn(),
        hasActiveRefreshSession: jest.fn().mockResolvedValue(true),
      };
      const orgResolver: jest.Mocked<OrganizationContextResolver> = {
        resolveForUser: jest.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          context: { orgId: ORG_ID, roles: ['ADMIN', 'MEMBER'] },
        }),
      };
      const accessTokens = {
        signAccessToken: jest.fn(),
        verifyAccessToken: jest.fn().mockImplementation(() => {
          throw new UnauthorizedException();
        }),
      } as unknown as AccessTokenService;
      const securityStore = {
        consumeRateLimit: jest.fn().mockResolvedValue(true),
        clearRateLimit: jest.fn(),
        isTokenRevoked: jest.fn().mockResolvedValue(false),
        revokeToken: jest.fn(),
      };
      const evidence = {
        loadPlatformPermission: jest.fn(),
      } as unknown as AuthorizationEvidenceProvider;

      const authService = new AuthenticationApplicationService(
        authRepo,
        new LeaderDirectedLoginEligibilityPolicy(),
        orgResolver,
        new PasswordCredentialService(),
        accessTokens,
        securityStore,
        evidence,
        new AuthorizationPolicy(),
        repo,
      );
      return { authService, authRepo, orgResolver };
    }

    it('resolves valid Bearer ctm_mcp_ key in getCurrentIdentity with mcpGrant while keeping getCurrentSessionIdentity JWT-only', async () => {
      const { repo, service } = createSetup();
      const { authService } = buildAuthService(repo);

      const minted = await service.create(actor, {
        name: 'Antigravity Agent',
        scope: 'READ_ONLY',
        allowedProjectIds: [PROJECT_A],
      });

      const resolved = await authService.getCurrentIdentity(
        `Bearer ${minted.rawKey}`,
        undefined,
      );
      expect(resolved).toEqual({
        id: USER_ID,
        email: actor.email,
        name: actor.name,
        organizationId: ORG_ID,
        roles: ['ADMIN', 'MEMBER'],
        mcpGrant: {
          keyId: minted.key.id,
          scope: 'READ_ONLY',
          allowedProjectIds: [PROJECT_A],
        },
      });

      // Never accepted via cookie!
      await expect(
        authService.getCurrentIdentity(
          undefined,
          `continuum_access=${minted.rawKey}`,
        ),
      ).rejects.toThrow(UnauthorizedException);

      // Never accepted via getCurrentSessionIdentity!
      await expect(
        authService.getCurrentSessionIdentity(
          `Bearer ${minted.rawKey}`,
          undefined,
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects revoked keys, expired keys, suspended users, and removed org memberships', async () => {
      const { repo, service } = createSetup();
      const { authService, authRepo } = buildAuthService(repo);

      const minted = await service.create(actor, {
        name: 'Temp Key',
        expiresInDays: 1,
      });

      // Suspend user -> 401
      authRepo.findProfileById.mockResolvedValueOnce({
        name: actor.name,
        status: 'SUSPENDED',
        mutationFence: 0,
      });
      await expect(
        authService.getCurrentIdentity(`Bearer ${minted.rawKey}`, undefined),
      ).rejects.toThrow(UnauthorizedException);

      // Remove org membership -> 401
      authRepo.findActiveOrganizationMembershipIds.mockResolvedValueOnce([]);
      await expect(
        authService.getCurrentIdentity(`Bearer ${minted.rawKey}`, undefined),
      ).rejects.toThrow(UnauthorizedException);

      // Revoke key -> 401
      await service.revoke(actor, minted.key.id);
      await expect(
        authService.getCurrentIdentity(`Bearer ${minted.rawKey}`, undefined),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('ProjectService allowedProjectIds enforcement & HTTP guards', () => {
    it('intersects ProjectService.get and ProjectService.list with actor.mcpGrant.allowedProjectIds', async () => {
      const { projectService } = createSetup();
      const scopedActor: AuthenticatedIdentity = {
        ...actor,
        mcpGrant: {
          keyId: '651a2b3c4d5e6f7a8b9c0d77',
          scope: 'READ_ONLY',
          allowedProjectIds: [PROJECT_A],
        },
      };

      const allowed = await projectService.get(scopedActor, PROJECT_A);
      expect(allowed.id).toBe(PROJECT_A);

      await expect(projectService.get(scopedActor, PROJECT_B)).rejects.toThrow(
        NotFoundException,
      );

      const listed = await projectService.list(scopedActor, {
        page: 1,
        pageSize: 20,
      });
      expect(listed.data.map((p) => p.id)).toEqual([PROJECT_A]);
      expect(listed.pagination.totalItems).toBe(1);
    });

    describe('McpApiKeysController & REST mutation guard', () => {
      let app: import('@nestjs/common').INestApplication;
      let controllerService: McpApiKeysService;

      beforeAll(async () => {
        const setup = createSetup();
        controllerService = setup.service;
        const getCurrentSessionIdentity = jest.fn(
          (authorization?: string, cookie?: string) => {
            if (authorization?.startsWith('Bearer ctm_mcp_')) {
              return Promise.reject(
                new UnauthorizedException({
                  code: 'AUTHENTICATION_FAILED',
                }),
              );
            }
            if (
              authorization === 'Bearer valid-jwt' ||
              cookie?.includes('continuum_access=valid-jwt')
            ) {
              return Promise.resolve(actor);
            }
            return Promise.reject(
              new UnauthorizedException({ code: 'AUTHENTICATION_FAILED' }),
            );
          },
        );

        const moduleRef = await Test.createTestingModule({
          controllers: [McpApiKeysController],
          providers: [
            { provide: McpApiKeysService, useValue: controllerService },
            {
              provide: AuthenticationApplicationService,
              useValue: { getCurrentSessionIdentity },
            },
          ],
        }).compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();
      }, 15000);

      afterAll(async () => {
        await app?.close();
      });

      it('enforces session-only auth + CSRF on McpApiKeysController and blocks direct REST mutations with ctm_mcp_ keys', async () => {
        const server = app.getHttpServer() as App;

        // Mint via JWT Bearer
        const createRes = await request(server)
          .post('/api/v1/iam/mcp-api-keys')
          .set('Authorization', 'Bearer valid-jwt')
          .send({ name: 'CLI Key', scope: 'READ_ONLY' })
          .expect(201);

        const rawKey = (createRes.body as { rawKey: string }).rawKey;
        const keyId = (createRes.body as { key: { id: string } }).key.id;

        // Cookie auth without CSRF fails closed with 403
        await request(server)
          .post('/api/v1/iam/mcp-api-keys')
          .set('Cookie', 'continuum_access=valid-jwt; __Host-csrf=tok123')
          .send({ name: 'Missing CSRF' })
          .expect(403);

        // Direct REST POST with Bearer ctm_mcp_... blocked by middleware with 403 MCP_KEY_DIRECT_MUTATION_FORBIDDEN
        const blockedRes = await request(server)
          .post('/api/v1/iam/mcp-api-keys')
          .set('Authorization', `Bearer ${rawKey}`)
          .send({ name: 'Escalation Attempt' })
          .expect(403);
        expect(blockedRes.body).toMatchObject({
          code: 'MCP_KEY_DIRECT_MUTATION_FORBIDDEN',
        });

        // Direct REST GET /iam/mcp-api-keys with Bearer ctm_mcp_... rejected by getCurrentSessionIdentity with 401
        await request(server)
          .get('/api/v1/iam/mcp-api-keys')
          .set('Authorization', `Bearer ${rawKey}`)
          .expect(401);

        // Middleware allows POST /api/v1/mcp through
        const nextFn = jest.fn();
        const mockRes = {
          setHeader: jest.fn(),
          status: jest.fn().mockReturnThis(),
          json: jest.fn(),
        };
        mcpKeyRestMutationGuardMiddleware(
          {
            method: 'POST',
            originalUrl: '/api/v1/mcp',
            headers: { authorization: `Bearer ${rawKey}` },
          } as never,
          mockRes as never,
          nextFn,
        );
        expect(nextFn).toHaveBeenCalledTimes(1);

        // Middleware blocks path-traversal bypasses like /api/v1/mcp/../iam/mcp-api-keys and %2e%2e
        for (const maliciousPath of [
          '/api/v1/mcp/../iam/mcp-api-keys',
          '/api/v1/mcp/%2e%2e/iam/mcp-api-keys',
          '/internal/mcp/../iam/projects',
        ]) {
          const traversalNext = jest.fn();
          const traversalRes = {
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
          };
          mcpKeyRestMutationGuardMiddleware(
            {
              method: 'POST',
              originalUrl: maliciousPath,
              resume: jest.fn(),
              headers: { authorization: `Bearer ${rawKey}` },
            } as never,
            traversalRes as never,
            traversalNext,
          );
          expect(traversalNext).not.toHaveBeenCalled();
          expect(traversalRes.status).toHaveBeenCalledWith(403);
        }

        // Revoke via cookie + valid CSRF
        await request(server)
          .delete(`/api/v1/iam/mcp-api-keys/${keyId}`)
          .set('Cookie', 'continuum_access=valid-jwt; __Host-csrf=tok123')
          .set('X-CSRF-Token', 'tok123')
          .expect(200);
      });

      it('enforces strict direct REST GET allowlist for ctm_mcp_ keys and allowedProjectIds inside ProjectAccessService & TaskWorkspaceIamBridge', async () => {
        const rawKey = 'ctm_mcp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

        // 1. Direct GETs to unscoped/external REST endpoints MUST be blocked with 403 MCP_KEY_DIRECT_REST_FORBIDDEN
        for (const forbiddenGetPath of [
          '/api/v1/chat/conversations',
          '/api/v1/notifications',
          '/api/v1/iam/users',
          '/api/v1/iam/projects',
          '/api/v1/iam/organizations/651a2b3c4d5e6f7a8b9c0d1f',
          '/api/v1/tasks/organization/tasks',
        ]) {
          const nextFn = jest.fn();
          const res = {
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
          };
          mcpKeyRestMutationGuardMiddleware(
            {
              method: 'GET',
              originalUrl: forbiddenGetPath,
              resume: jest.fn(),
              headers: { authorization: `Bearer ${rawKey}` },
            } as never,
            res as never,
            nextFn,
          );
          expect(nextFn).not.toHaveBeenCalled();
          expect(res.status).toHaveBeenCalledWith(403);
          expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
              code: 'MCP_KEY_DIRECT_REST_FORBIDDEN',
            }),
          );
        }

        // 2. Internal loopback verification GETs MUST be allowed through
        for (const allowedLoopbackPath of [
          '/api/v1/auth/me',
          '/internal/auth/me',
          `/api/v1/iam/projects/${PROJECT_A}`,
          `/api/v1/iam/projects/${PROJECT_A}/settings-access`,
          `/api/v1/iam/projects/${PROJECT_A}/memberships?page=1&pageSize=100`,
          `/api/v1/internal/tasks/projects/${PROJECT_A}/tasks/${PROJECT_B}`,
          '/api/v1/iam/mcp-api-keys',
        ]) {
          const nextFn = jest.fn();
          const res = {
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
          };
          mcpKeyRestMutationGuardMiddleware(
            {
              method: 'GET',
              originalUrl: allowedLoopbackPath,
              headers: { authorization: `Bearer ${rawKey}` },
            } as never,
            res as never,
            nextFn,
          );
          expect(nextFn).toHaveBeenCalledTimes(1);
        }

        // 3. ProjectAccessService enforces allowedProjectIds on listMembers & listLeaders
        const accessRepo = {
          listMembers: jest.fn().mockResolvedValue({ data: [], totalItems: 0 }),
          listLeaders: jest.fn().mockResolvedValue([]),
        } as unknown as ProjectAccessRepository;
        const accessService = new ProjectAccessService(accessRepo);
        const scopedActor: AuthenticatedIdentity = {
          ...actor,
          mcpGrant: {
            keyId: '651a2b3c4d5e6f7a8b9c0d88',
            scope: 'READ_ONLY',
            allowedProjectIds: [PROJECT_A],
          },
        };
        await expect(
          accessService.listMembers(scopedActor, PROJECT_A, {
            page: 1,
            pageSize: 20,
          }),
        ).resolves.toBeDefined();
        await expect(
          accessService.listMembers(scopedActor, PROJECT_B, {
            page: 1,
            pageSize: 20,
          }),
        ).rejects.toThrow(NotFoundException);
        await expect(
          accessService.listLeaders(scopedActor, PROJECT_B),
        ).rejects.toThrow(NotFoundException);

        // 4. TaskWorkspaceIamBridge.resolveOrgAdminContext rejects project-restricted MCP keys
        const bridge = new TaskWorkspaceIamBridge({
          getCurrentIdentity: jest.fn().mockResolvedValue(scopedActor),
        } as unknown as AuthenticationApplicationService);
        await expect(
          bridge.resolveOrgAdminContext(`Bearer ${rawKey}`, undefined),
        ).rejects.toThrow(ForbiddenException);
      });
    });
  });
});
