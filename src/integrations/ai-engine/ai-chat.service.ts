import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import {
  PLATFORM_ADMINISTRATION_REPOSITORY,
  type PlatformAdministrationRepository,
} from '../../services/iam/application/platform/platform-administration.repository';
import { HandoverIamScopeService } from '../../services/iam/application/projects/handover-iam-scope.service';
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
  sanitizeContinuumActorHeaderName,
} from './ai-chat.types';

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

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

  private async resolveSagSession(
    headers: AiChatRequestHeaders,
    projectId: string,
    options?: { requireActiveProject?: boolean },
  ): Promise<{
    agentId: string;
    bearerHeaders: Record<string, string>;
    cacheKey: string;
  }> {
    const actor = await this.auth.getCurrentIdentity(
      headers.authorization,
      headers.cookie,
    );
    const project = await this.projects.get(actor, projectId);
    if (options?.requireActiveProject && project.status !== 'ACTIVE') {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }
    const sanitizedName = sanitizeContinuumActorHeaderName(actor.name);
    const cacheKey = `${actor.id}:${project.organizationId}:${project.id}:${sanitizedName}`;

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
            'X-Continuum-Organization-Id': project.organizationId,
            'X-Continuum-Project-Id': project.id,
          },
          body: {},
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

  async generateMindMap(
    headers: AiChatRequestHeaders,
    projectId: string,
    input: AiChatMindMapInputDto,
  ): Promise<AiChatMindMapResponseDto> {
    const actor = await this.auth.getCurrentIdentity(
      headers.authorization,
      headers.cookie,
    );
    const project = await this.projects.get(actor, projectId);
    if (project.status !== 'ACTIVE') {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }

    const result = await this.aiEngine.request<unknown>({
      path: `/api/v1/projects/${encodeURIComponent(project.id)}/mind-map`,
      method: 'POST',
      headers: {
        'X-Continuum-User-Id': actor.id,
        'X-Continuum-Organization-Id': project.organizationId,
        'X-Continuum-Tenant-Id': project.organizationId,
        'X-Continuum-Project-Id': project.id,
        'X-Continuum-Security-Partition': project.id,
      },
      body: input.topic ? { topic: input.topic } : {},
    });

    const mapped = mapSagMindMapResponse(result.body);
    if (!mapped) {
      throw new BadGatewayException(
        'AI Engine returned an invalid mind map payload.',
      );
    }
    return mapped;
  }
}
