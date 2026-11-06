import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AuthenticationApplicationService,
  type AuthenticatedIdentity,
} from '../../services/iam/application/authentication/authentication.application.service';
import {
  PLATFORM_ADMINISTRATION_REPOSITORY,
  type PlatformAdministrationRepository,
} from '../../services/iam/application/platform/platform-administration.repository';
import { HandoverIamScopeService } from '../../services/iam/application/projects/handover-iam-scope.service';
import type { ProjectRecord } from '../../services/iam/application/projects/project.repository';
import { ProjectService } from '../../services/iam/application/projects/project.service';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import type { AiEngineClient } from './ai-engine.port';
import { transformSagSseStream } from './ai-chat-sse.parser';
import {
  type AiChatFeedbackDto,
  type AiChatFeedbackInputDto,
  type AiChatMessagePageDto,
  type AiChatMindMapInputDto,
  type AiChatMindMapResponseDto,
  type AiChatOwnFeedbackDto,
  type AiChatRequestHeaders,
  type AiChatShareDto,
  type AiChatSharedAnswerDto,
  type AiChatSseFrame,
  type AiChatThreadDto,
  type PlatformAiFeedbackPageDto,
  type PlatformAiFeedbackQueryDto,
  mapSagAdminFeedbackPage,
  mapSagFeedback,
  mapSagMessage,
  mapSagMindMapResponse,
  mapSagOwnFeedback,
  mapSagShare,
  mapSagSharedAnswer,
  mapSagThread,
  sanitizeContinuumActorDisplayName,
  sanitizeContinuumActorHeaderName,
} from './ai-chat.types';

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
export const AI_CHAT_ALL_PROJECTS_ID = 'all';
const MAX_ALL_PROJECTS_COUNT = 256;

type SagLoginResponse = Readonly<{ access_token?: unknown }>;
type SagAgentResponse = Readonly<{ id?: unknown }>;
type SagMessagePageResponse = Readonly<{
  items?: unknown;
  next_cursor?: unknown;
  has_more?: unknown;
}>;

type CachedSagSession = Readonly<{
  agentId: string;
  bearerHeaders: Record<string, string>;
  expiresAt: number;
}>;

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAG_SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SAG_SESSION_CACHE_ENTRIES = 500;

@Injectable()
export class AiChatService {
  private readonly sessionCache = new Map<string, CachedSagSession>();
  private readonly inflightSessions = new Map<
    string,
    Promise<CachedSagSession>
  >();
  private readonly inflightActorScopes = new Map<
    string,
    Promise<{
      actor: Awaited<
        ReturnType<AuthenticationApplicationService['getCurrentIdentity']>
      >;
      project: Awaited<ReturnType<ProjectService['get']>>;
    }>
  >();

  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly projects: ProjectService,
    @Inject(AI_ENGINE_CLIENT) private readonly aiEngine: AiEngineClient,
    @Optional() private readonly iamScope?: HandoverIamScopeService,
    @Optional()
    @Inject(PLATFORM_ADMINISTRATION_REPOSITORY)
    private readonly platformAdmin?: PlatformAdministrationRepository,
  ) {}

  private setSessionCacheEntry(key: string, entry: CachedSagSession): void {
    const now = Date.now();
    if (this.sessionCache.size >= MAX_SAG_SESSION_CACHE_ENTRIES) {
      for (const [k, existing] of this.sessionCache) {
        if (existing.expiresAt <= now) {
          this.sessionCache.delete(k);
        }
      }
      if (this.sessionCache.size >= MAX_SAG_SESSION_CACHE_ENTRIES) {
        for (const firstKey of this.sessionCache.keys()) {
          this.sessionCache.delete(firstKey);
          break;
        }
      }
    }
    this.sessionCache.set(key, entry);
  }

  private isAllProjectsScope(projectId: string): boolean {
    return projectId.trim().toLowerCase() === AI_CHAT_ALL_PROJECTS_ID;
  }

  private assertOrganizationManagerForAllProjects(
    actor: AuthenticatedIdentity,
    headers: AiChatRequestHeaders,
  ): void {
    const requestedOrgId = headers.organizationId?.trim();
    if (requestedOrgId && requestedOrgId !== actor.organizationId) {
      throw new ForbiddenException({
        code: 'AI_CHAT_ALL_PROJECTS_FORBIDDEN',
        message: 'Organization scope does not match the authenticated user.',
      });
    }
    if (!Array.isArray(actor.roles) || !actor.roles.includes('ADMIN')) {
      throw new ForbiddenException({
        code: 'AI_CHAT_ALL_PROJECTS_FORBIDDEN',
        message:
          'Only Organization Managers can access AI Chat across all projects.',
      });
    }
  }

  private async listAllActiveOrganizationProjects(
    actor: AuthenticatedIdentity,
  ): Promise<ProjectRecord[]> {
    const pageSize = 100;
    const dedupedById = new Map<string, ProjectRecord>();
    const collectActive = (items: readonly ProjectRecord[]) => {
      for (const proj of items) {
        if (proj.status === 'ACTIVE' && OBJECT_ID_PATTERN.test(proj.id)) {
          dedupedById.set(proj.id, proj);
          if (dedupedById.size > MAX_ALL_PROJECTS_COUNT) {
            return;
          }
        }
      }
    };

    const firstPage = await this.projects.list(actor, {
      page: 1,
      pageSize,
      status: 'ACTIVE',
    });
    collectActive(firstPage.data);

    const totalPages = Math.min(firstPage.pagination.totalPages ?? 1, 10);
    for (let page = 2; page <= totalPages; page += 1) {
      if (dedupedById.size > MAX_ALL_PROJECTS_COUNT) break;
      const next = await this.projects.list(actor, {
        page,
        pageSize,
        status: 'ACTIVE',
      });
      collectActive(next.data);
    }

    if (dedupedById.size > MAX_ALL_PROJECTS_COUNT) {
      throw new BadRequestException({
        code: 'AI_CHAT_ALL_PROJECTS_LIMIT_EXCEEDED',
        message: `All-projects scope supports at most ${MAX_ALL_PROJECTS_COUNT} active projects. Please select a specific project.`,
      });
    }
    return [...dedupedById.values()];
  }

  async resolveAllProjectsManagerContext(
    headers: AiChatRequestHeaders,
  ): Promise<{
    actorId: string;
    organizationId: string;
    projects: ReadonlyArray<{ id: string; code: string; name: string }>;
  }> {
    const actor = await this.auth.getCurrentIdentity(
      headers.authorization,
      headers.cookie,
    );
    this.assertOrganizationManagerForAllProjects(actor, headers);
    const activeProjects = await this.listAllActiveOrganizationProjects(actor);
    return {
      actorId: actor.id,
      organizationId: actor.organizationId,
      projects: activeProjects.map((project) => ({
        id: project.id,
        code: project.code,
        name: project.name,
      })),
    };
  }

  private async resolveSagSession(
    headers: AiChatRequestHeaders,
    projectId: string,
    options?: { requireActiveProject?: boolean },
  ): Promise<{
    agentId: string;
    bearerHeaders: Record<string, string>;
    cacheKey: string;
  }> {
    const isAllProjects = this.isAllProjectsScope(projectId);
    let actor: Awaited<
      ReturnType<AuthenticationApplicationService['getCurrentIdentity']>
    >;
    let resolvedOrganizationId: string;
    let resolvedProjectId: string;
    let allowedProjectIds: string[] | undefined;

    if (isAllProjects) {
      actor = await this.auth.getCurrentIdentity(
        headers.authorization,
        headers.cookie,
      );
      this.assertOrganizationManagerForAllProjects(actor, headers);
      const activeProjects =
        await this.listAllActiveOrganizationProjects(actor);
      if (activeProjects.length === 0) {
        throw new NotFoundException({
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found.',
        });
      }
      resolvedOrganizationId = actor.organizationId;
      resolvedProjectId = AI_CHAT_ALL_PROJECTS_ID;
      allowedProjectIds = activeProjects.map((project) => project.id).sort();
    } else {
      const scopeInflightKey = `${headers.authorization ?? ''}|${headers.cookie ?? ''}|${projectId}`;
      let pendingScope = this.inflightActorScopes.get(scopeInflightKey);
      if (!pendingScope) {
        pendingScope = (async () => {
          const resolvedActor = await this.auth.getCurrentIdentity(
            headers.authorization,
            headers.cookie,
          );
          const resolvedProject = await this.projects.get(
            resolvedActor,
            projectId,
          );
          return { actor: resolvedActor, project: resolvedProject };
        })().finally(() => {
          this.inflightActorScopes.delete(scopeInflightKey);
        });
        this.inflightActorScopes.set(scopeInflightKey, pendingScope);
      }
      const resolvedScope = await pendingScope;
      actor = resolvedScope.actor;
      const project = resolvedScope.project;
      if (options?.requireActiveProject && project.status !== 'ACTIVE') {
        throw new NotFoundException({
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found.',
        });
      }
      resolvedOrganizationId = project.organizationId;
      resolvedProjectId = project.id;
    }

    const sanitizedName = sanitizeContinuumActorHeaderName(actor.name);
    const displayName = sanitizeContinuumActorDisplayName(actor.name);
    const cacheScopePart = allowedProjectIds
      ? `${AI_CHAT_ALL_PROJECTS_ID}:${allowedProjectIds.join(',')}`
      : resolvedProjectId;
    const cacheKey = `${actor.id}:${resolvedOrganizationId}:${cacheScopePart}:${displayName}`;

    const cached = this.sessionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        agentId: cached.agentId,
        bearerHeaders: cached.bearerHeaders,
        cacheKey,
      };
    }
    this.sessionCache.delete(cacheKey);

    let pending = this.inflightSessions.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const loginResult = await this.aiEngine.request<SagLoginResponse>({
          path: '/api/v1/auth/continuum-login',
          method: 'POST',
          headers: {
            'X-Continuum-User-Id': actor.id,
            'X-Continuum-Name': sanitizedName,
            'X-Continuum-Organization-Id': resolvedOrganizationId,
            'X-Continuum-Project-Id': resolvedProjectId,
          },
          body: allowedProjectIds
            ? { displayName, allowed_project_ids: allowedProjectIds }
            : { displayName },
        });

        const token = loginResult.body?.access_token;
        if (
          typeof token !== 'string' ||
          token.length > 8192 ||
          token.split('.').length !== 3
        ) {
          throw new BadGatewayException(
            'AI Engine returned an invalid login response.',
          );
        }

        const bearerHeaders = { Authorization: `Bearer ${token}` };
        const agentResult = await this.aiEngine.request<SagAgentResponse>({
          path: '/api/v1/agents/default',
          method: 'GET',
          headers: bearerHeaders,
        });

        const agentId =
          typeof agentResult.body?.id === 'string'
            ? agentResult.body.id.trim()
            : '';
        if (!SAFE_ID_PATTERN.test(agentId)) {
          throw new BadGatewayException(
            'AI Engine returned an invalid default agent identifier.',
          );
        }

        const entry: CachedSagSession = {
          agentId,
          bearerHeaders,
          expiresAt: Date.now() + SAG_SESSION_CACHE_TTL_MS,
        };
        this.setSessionCacheEntry(cacheKey, entry);
        return entry;
      })().finally(() => {
        this.inflightSessions.delete(cacheKey);
      });
      this.inflightSessions.set(cacheKey, pending);
    }

    const resolved = await pending;
    return {
      agentId: resolved.agentId,
      bearerHeaders: resolved.bearerHeaders,
      cacheKey,
    };
  }

  async listThreads(
    headers: AiChatRequestHeaders,
    projectId: string,
    query: Readonly<{ limit: number; offset: number }>,
  ): Promise<AiChatThreadDto[]> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const params = new URLSearchParams({
      limit: String(query.limit),
      offset: String(query.offset),
    });
    let result: { status: number; body: unknown };
    try {
      result = await this.aiEngine.request<unknown>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads?${params.toString()}`,
        method: 'GET',
        headers: bearerHeaders,
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }

    if (!Array.isArray(result.body)) {
      throw new BadGatewayException(
        'AI Engine returned an invalid thread list.',
      );
    }
    return result.body
      .map(mapSagThread)
      .filter((item): item is AiChatThreadDto => item !== null);
  }

  async createThread(
    headers: AiChatRequestHeaders,
    projectId: string,
    input: Readonly<{ title?: string }>,
  ): Promise<AiChatThreadDto> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    let result: { status: number; body: unknown };
    try {
      result = await this.aiEngine.request<unknown>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads`,
        method: 'POST',
        headers: bearerHeaders,
        body: { title: input.title ?? 'New chat' },
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }

    const mapped = mapSagThread(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid thread payload.',
      );
    }
    return mapped;
  }

  async branchThread(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    messageId: string,
    input: Readonly<{ title?: string }>,
  ): Promise<AiChatThreadDto> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
      { requireActiveProject: true },
    );
    let result: { status: number; body: unknown };
    try {
      result = await this.aiEngine.request<unknown>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/branch`,
        method: 'POST',
        headers: bearerHeaders,
        body: input.title ? { title: input.title } : {},
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }

    const mapped = mapSagThread(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid branched thread payload.',
      );
    }
    return mapped;
  }

  async updateThread(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    input: Readonly<{ title: string }>,
  ): Promise<AiChatThreadDto> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    let result: { status: number; body: unknown };
    try {
      result = await this.aiEngine.request<unknown>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`,
        method: 'PATCH',
        headers: bearerHeaders,
        body: { title: input.title },
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }

    const mapped = mapSagThread(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid thread payload.',
      );
    }
    return mapped;
  }

  async deleteThread(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
  ): Promise<void> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    try {
      await this.aiEngine.request<unknown>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`,
        method: 'DELETE',
        headers: bearerHeaders,
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }
  }

  async listMessages(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    query: Readonly<{ limit: number; cursor?: string }>,
  ): Promise<AiChatMessagePageDto> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const params = new URLSearchParams({
      limit: String(query.limit),
    });
    if (query.cursor) {
      params.set('cursor', query.cursor);
    }
    let result: { status: number; body: SagMessagePageResponse };
    try {
      result = await this.aiEngine.request<SagMessagePageResponse>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages?${params.toString()}`,
        method: 'GET',
        headers: bearerHeaders,
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }

    const rawItems = result.body?.items;
    if (!Array.isArray(rawItems)) {
      throw new BadGatewayException(
        'AI Engine returned an invalid message page.',
      );
    }

    const nextCursor =
      typeof result.body?.next_cursor === 'string' &&
      result.body.next_cursor.trim()
        ? result.body.next_cursor.trim()
        : null;
    const hasMore = Boolean(result.body?.has_more);

    return {
      items: rawItems
        .map(mapSagMessage)
        .filter((item): item is NonNullable<typeof item> => item !== null),
      nextCursor,
      hasMore,
    };
  }

  async openAskStream(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    input: Readonly<{ query: string }>,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<AiChatSseFrame>> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    let upstream: Awaited<ReturnType<AiEngineClient['requestStream']>>;
    try {
      upstream = await this.aiEngine.requestStream({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/ask`,
        method: 'POST',
        headers: bearerHeaders,
        body: {
          query: input.query,
          web_enabled: false,
          knowledge_only: true,
        },
        signal,
      });
    } catch (error) {
      if (!signal?.aborted) {
        this.sessionCache.delete(cacheKey);
      }
      throw error;
    }

    return this.enrichSagSseStream(
      upstream.stream,
      agentId,
      threadId,
      bearerHeaders,
      signal,
    );
  }

  private enrichSagSseStream(
    stream: ReadableStream<Uint8Array>,
    agentId: string,
    threadId: string,
    bearerHeaders: Record<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<AiChatSseFrame> {
    const aiEngine = this.aiEngine;
    async function* enrichedStream(): AsyncGenerator<AiChatSseFrame> {
      for await (const frame of transformSagSseStream(stream, {
        threadId,
        signal,
      })) {
        if (
          frame.event === 'completed' &&
          frame.data.messageId &&
          !signal?.aborted
        ) {
          try {
            const latestPage = await aiEngine.request<SagMessagePageResponse>({
              path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages?limit=5`,
              method: 'GET',
              headers: bearerHeaders,
            });
            const rawItems = Array.isArray(latestPage.body?.items)
              ? latestPage.body.items
              : [];
            const persisted = rawItems
              .map(mapSagMessage)
              .find((msg) => msg?.id === frame.data.messageId);
            if (persisted) {
              yield {
                event: 'completed',
                data: {
                  ...frame.data,
                  ...(persisted.replyToMessageId
                    ? { replyToMessageId: persisted.replyToMessageId }
                    : {}),
                  ...(persisted.regeneratedFromMessageId
                    ? {
                        regeneratedFromMessageId:
                          persisted.regeneratedFromMessageId,
                      }
                    : {}),
                  sessionCitations: persisted.sessionCitations,
                  retrievalSteps:
                    persisted.retrievalSteps.length > 0
                      ? persisted.retrievalSteps
                      : frame.data.retrievalSteps,
                },
              };
              continue;
            }
          } catch {
            // Best-effort ECCE hydration; preserve primary completed event if lookup fails.
          }
        }
        yield frame;
      }
    }

    return enrichedStream();
  }

  async getOwnFeedback(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    messageId: string,
  ): Promise<AiChatOwnFeedbackDto> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
      { requireActiveProject: true },
    );
    let result: { status: number; body: unknown };
    try {
      result = await this.aiEngine.request<unknown>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/feedback`,
        method: 'GET',
        headers: bearerHeaders,
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }

    const mapped = mapSagOwnFeedback(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid feedback payload.',
      );
    }
    return mapped;
  }

  async putOwnFeedback(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    messageId: string,
    input: AiChatFeedbackInputDto,
  ): Promise<AiChatFeedbackDto> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
      { requireActiveProject: true },
    );
    let result: { status: number; body: unknown };
    try {
      result = await this.aiEngine.request<unknown>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/feedback`,
        method: 'PUT',
        headers: bearerHeaders,
        body: {
          rating: input.rating,
          ...(input.reasonCategory
            ? { reasonCategory: input.reasonCategory }
            : {}),
          ...(input.reasonText ? { reasonText: input.reasonText } : {}),
        },
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }

    const mapped = mapSagFeedback(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid feedback payload.',
      );
    }
    return mapped;
  }

  async deleteOwnFeedback(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    messageId: string,
  ): Promise<void> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
      { requireActiveProject: true },
    );
    try {
      await this.aiEngine.request<void>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/feedback`,
        method: 'DELETE',
        headers: bearerHeaders,
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }
  }

  async createShare(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    messageId: string,
  ): Promise<{ status: 200 | 201; share: AiChatShareDto }> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
      { requireActiveProject: true },
    );
    let result: { status: number; body: unknown };
    try {
      result = await this.aiEngine.request<unknown>({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/shares`,
        method: 'POST',
        headers: bearerHeaders,
        body: {},
      });
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }

    const mapped = mapSagShare(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid share payload.',
      );
    }
    return {
      status: result.status === 201 ? 201 : 200,
      share: mapped,
    };
  }

  private async resolveActiveProjectMemberHeaders(
    headers: AiChatRequestHeaders,
    projectId: string,
  ): Promise<{
    normalizedProjectId: string;
    bffHeaders: Record<string, string>;
  }> {
    const actor = await this.auth.getCurrentIdentity(
      headers.authorization,
      headers.cookie,
    );
    if (this.isAllProjectsScope(projectId)) {
      this.assertOrganizationManagerForAllProjects(actor, headers);
      const activeProjects =
        await this.listAllActiveOrganizationProjects(actor);
      if (activeProjects.length === 0) {
        throw new NotFoundException({
          code: 'AI_CHAT_SHARE_NOT_FOUND',
          message: 'Shared answer was not found.',
        });
      }
      const allowedProjectIds = activeProjects.map((p) => p.id).sort();
      return {
        normalizedProjectId: AI_CHAT_ALL_PROJECTS_ID,
        bffHeaders: {
          'X-Continuum-User-Id': actor.id,
          'X-Continuum-Organization-Id': actor.organizationId,
          'X-Continuum-Tenant-Id': actor.organizationId,
          'X-Continuum-Project-Id': AI_CHAT_ALL_PROJECTS_ID,
          'X-Continuum-Security-Partition': AI_CHAT_ALL_PROJECTS_ID,
          'X-Continuum-Allowed-Project-Ids': allowedProjectIds.join(','),
        },
      };
    }
    if (!OBJECT_ID_PATTERN.test(projectId)) {
      throw new NotFoundException({
        code: 'AI_CHAT_SHARE_NOT_FOUND',
        message: 'Shared answer was not found.',
      });
    }
    if (!this.iamScope) {
      throw new ServiceUnavailableException({
        code: 'IAM_SCOPE_UNAVAILABLE',
        message: 'Project membership verification is temporarily unavailable.',
      });
    }
    const scope = await this.iamScope.resolveProjectActorContext({
      actor,
      projectId,
      organizationHeader: headers.organizationId,
    });
    if (!scope.isProjectMember) {
      throw new NotFoundException({
        code: 'AI_CHAT_SHARE_NOT_FOUND',
        message: 'Shared answer was not found.',
      });
    }
    return {
      normalizedProjectId: scope.projectId,
      bffHeaders: {
        'X-Continuum-User-Id': scope.userId,
        'X-Continuum-Organization-Id': scope.organizationId,
        'X-Continuum-Tenant-Id': scope.organizationId,
        'X-Continuum-Project-Id': scope.projectId,
        'X-Continuum-Security-Partition': scope.projectId,
      },
    };
  }

  async readSharedAnswer(
    headers: AiChatRequestHeaders,
    projectId: string,
    shareId: string,
  ): Promise<AiChatSharedAnswerDto> {
    const { normalizedProjectId, bffHeaders } =
      await this.resolveActiveProjectMemberHeaders(headers, projectId);
    const result = await this.aiEngine.request<unknown>({
      path: `/api/v1/projects/${encodeURIComponent(normalizedProjectId)}/shares/${encodeURIComponent(shareId)}`,
      method: 'GET',
      headers: bffHeaders,
    });
    const mapped = mapSagSharedAnswer(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid shared answer payload.',
      );
    }
    return mapped;
  }

  async revokeShare(
    headers: AiChatRequestHeaders,
    projectId: string,
    shareId: string,
  ): Promise<void> {
    const { normalizedProjectId, bffHeaders } =
      await this.resolveActiveProjectMemberHeaders(headers, projectId);
    await this.aiEngine.request<void>({
      path: `/api/v1/projects/${encodeURIComponent(normalizedProjectId)}/shares/${encodeURIComponent(shareId)}`,
      method: 'DELETE',
      headers: bffHeaders,
    });
  }

  async openRegenerateStream(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<AiChatSseFrame>> {
    const { agentId, bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
      { requireActiveProject: true },
    );
    let upstream: Awaited<ReturnType<AiEngineClient['requestStream']>>;
    try {
      upstream = await this.aiEngine.requestStream({
        path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/regenerate`,
        method: 'POST',
        headers: bearerHeaders,
        body: {},
        signal,
      });
    } catch (error) {
      if (!signal?.aborted) {
        this.sessionCache.delete(cacheKey);
      }
      throw error;
    }

    return this.enrichSagSseStream(
      upstream.stream,
      agentId,
      threadId,
      bearerHeaders,
      signal,
    );
  }

  async listPlatformFeedback(
    query: PlatformAiFeedbackQueryDto,
  ): Promise<PlatformAiFeedbackPageDto> {
    if (query.organizationId !== undefined || query.projectId !== undefined) {
      if (!this.platformAdmin) {
        throw new ServiceUnavailableException({
          code: 'PLATFORM_ADMINISTRATION_UNAVAILABLE',
          message:
            'Organization and Project verification is temporarily unavailable.',
        });
      }
      try {
        const [org, proj] = await Promise.all([
          query.organizationId
            ? this.platformAdmin.findOrganization(query.organizationId)
            : Promise.resolve(null),
          query.projectId
            ? this.platformAdmin.findProject(query.projectId)
            : Promise.resolve(null),
        ]);
        if (query.organizationId && !org) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'organizationId is invalid or unknown.',
          });
        }
        if (query.projectId && !proj) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'projectId is invalid or unknown.',
          });
        }
        if (
          query.organizationId &&
          proj &&
          proj.organization.id !== query.organizationId
        ) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'projectId does not belong to organizationId.',
          });
        }
      } catch (error) {
        if (error instanceof HttpException) {
          throw error;
        }
        throw new ServiceUnavailableException({
          code: 'PLATFORM_ADMINISTRATION_UNAVAILABLE',
          message:
            'Organization and Project verification is temporarily unavailable.',
        });
      }
    }

    const params = new URLSearchParams({
      limit: String(query.limit),
    });
    if (query.organizationId)
      params.set('organizationId', query.organizationId);
    if (query.projectId) params.set('projectId', query.projectId);
    if (query.rating) params.set('rating', query.rating);
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    if (query.cursor) params.set('cursor', query.cursor);

    const result = await this.aiEngine.request<unknown>({
      path: `/api/v1/platform/ai/feedback?${params.toString()}`,
      method: 'GET',
      headers: {},
    });

    const mapped = mapSagAdminFeedbackPage(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid platform feedback payload.',
      );
    }
    return mapped;
  }

  private async resolveActiveMindMapScope(
    headers: AiChatRequestHeaders,
    projectId: string,
  ): Promise<{
    projectId: string;
    bffHeaders: Record<string, string>;
  }> {
    if (this.isAllProjectsScope(projectId)) {
      const actor = await this.auth.getCurrentIdentity(
        headers.authorization,
        headers.cookie,
      );
      this.assertOrganizationManagerForAllProjects(actor, headers);
      const activeProjects =
        await this.listAllActiveOrganizationProjects(actor);
      if (activeProjects.length === 0) {
        throw new NotFoundException({
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found.',
        });
      }
      const allowedProjectIds = activeProjects.map((p) => p.id).sort();
      return {
        projectId: AI_CHAT_ALL_PROJECTS_ID,
        bffHeaders: {
          'X-Continuum-User-Id': actor.id,
          'X-Continuum-Organization-Id': actor.organizationId,
          'X-Continuum-Tenant-Id': actor.organizationId,
          'X-Continuum-Project-Id': AI_CHAT_ALL_PROJECTS_ID,
          'X-Continuum-Security-Partition': AI_CHAT_ALL_PROJECTS_ID,
          'X-Continuum-Allowed-Project-Ids': allowedProjectIds.join(','),
        },
      };
    }
    const scopeInflightKey = `${headers.authorization ?? ''}|${headers.cookie ?? ''}|${projectId}`;
    let pendingScope = this.inflightActorScopes.get(scopeInflightKey);
    if (!pendingScope) {
      pendingScope = (async () => {
        const resolvedActor = await this.auth.getCurrentIdentity(
          headers.authorization,
          headers.cookie,
        );
        const resolvedProject = await this.projects.get(
          resolvedActor,
          projectId,
        );
        return { actor: resolvedActor, project: resolvedProject };
      })().finally(() => {
        this.inflightActorScopes.delete(scopeInflightKey);
      });
      this.inflightActorScopes.set(scopeInflightKey, pendingScope);
    }
    const { actor, project } = await pendingScope;
    if (project.status !== 'ACTIVE') {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }
    return {
      projectId: project.id,
      bffHeaders: {
        'X-Continuum-User-Id': actor.id,
        'X-Continuum-Organization-Id': project.organizationId,
        'X-Continuum-Tenant-Id': project.organizationId,
        'X-Continuum-Project-Id': project.id,
        'X-Continuum-Security-Partition': project.id,
      },
    };
  }

  async getMindMap(
    headers: AiChatRequestHeaders,
    projectId: string,
    topic?: string,
  ): Promise<AiChatMindMapResponseDto> {
    const scope = await this.resolveActiveMindMapScope(headers, projectId);
    const querySuffix = topic ? `?topic=${encodeURIComponent(topic)}` : '';
    const result = await this.aiEngine.request<unknown>({
      path: `/api/v1/projects/${encodeURIComponent(scope.projectId)}/mind-map${querySuffix}`,
      method: 'GET',
      headers: scope.bffHeaders,
    });

    const mapped = mapSagMindMapResponse(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid mind map payload.',
      );
    }
    return mapped;
  }

  async generateMindMap(
    headers: AiChatRequestHeaders,
    projectId: string,
    input: AiChatMindMapInputDto,
  ): Promise<AiChatMindMapResponseDto> {
    const scope = await this.resolveActiveMindMapScope(headers, projectId);

    const result = await this.aiEngine.request<unknown>({
      path: `/api/v1/projects/${encodeURIComponent(scope.projectId)}/mind-map`,
      method: 'POST',
      headers: scope.bffHeaders,
      body: {
        ...(input.topic ? { topic: input.topic } : {}),
        ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
      },
    });

    const mapped = mapSagMindMapResponse(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid mind map payload.',
      );
    }
    return mapped;
  }

  async getKnowledgeUniverseOverview(
    headers: AiChatRequestHeaders,
    projectId: string,
  ): Promise<unknown> {
    const { bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const params = new URLSearchParams({
      project_id: projectId,
    });
    try {
      const result = await this.aiEngine.request<unknown>({
        path: `/api/v1/universe/knowledge/overview?${params.toString()}`,
        method: 'GET',
        headers: bearerHeaders,
      });
      return result.body;
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }
  }

  async getKnowledgeUniverseCluster(
    headers: AiChatRequestHeaders,
    projectId: string,
    query: Readonly<{
      treeVersion: string;
      nodeId: string;
      limit: number;
      cursor?: string;
      relatedTo?: string;
    }>,
  ): Promise<unknown> {
    const { bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const params = new URLSearchParams({
      project_id: projectId,
      tree_version: query.treeVersion,
      node_id: query.nodeId,
      limit: String(query.limit),
    });
    if (query.cursor) {
      params.set('cursor', query.cursor);
    }
    if (query.relatedTo) {
      params.set('related_to', query.relatedTo);
    }
    try {
      const result = await this.aiEngine.request<unknown>({
        path: `/api/v1/universe/knowledge/cluster?${params.toString()}`,
        method: 'GET',
        headers: bearerHeaders,
      });
      return result.body;
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }
  }

  async getKnowledgeUniverseUnit(
    headers: AiChatRequestHeaders,
    projectId: string,
    unitId: string,
    treeVersion: string,
  ): Promise<unknown> {
    const { bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const params = new URLSearchParams({
      project_id: projectId,
      tree_version: treeVersion,
    });
    try {
      const result = await this.aiEngine.request<unknown>({
        path: `/api/v1/universe/knowledge/units/${encodeURIComponent(unitId)}?${params.toString()}`,
        method: 'GET',
        headers: bearerHeaders,
      });
      return result.body;
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }
  }

  async resolveKnowledgeUniverseReferences(
    headers: AiChatRequestHeaders,
    projectId: string,
    references: ReadonlyArray<{
      source_id: string;
      document_version_id?: string | null;
      search_unit_id?: string | null;
      block_id?: string | null;
    }>,
  ): Promise<unknown> {
    const { bearerHeaders, cacheKey } = await this.resolveSagSession(
      headers,
      projectId,
    );
    try {
      const result = await this.aiEngine.request<unknown>({
        path: '/api/v1/universe/knowledge/resolve',
        method: 'POST',
        headers: bearerHeaders,
        body: { references },
      });
      return result.body;
    } catch (error) {
      this.sessionCache.delete(cacheKey);
      throw error;
    }
  }
}
