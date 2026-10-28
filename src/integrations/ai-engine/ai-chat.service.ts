import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import { AuthenticationApplicationService } from '../../services/iam/application/authentication/authentication.application.service';
import { ProjectService } from '../../services/iam/application/projects/project.service';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import type { AiEngineClient } from './ai-engine.port';
import { transformSagSseStream } from './ai-chat-sse.parser';
import {
  type AiChatMessagePageDto,
  type AiChatRequestHeaders,
  type AiChatSseFrame,
  type AiChatThreadDto,
  mapSagMessage,
  mapSagThread,
} from './ai-chat.types';

type SagLoginResponse = Readonly<{ access_token?: unknown }>;
type SagAgentResponse = Readonly<{ id?: unknown }>;
type SagMessagePageResponse = Readonly<{
  items?: unknown;
  next_cursor?: unknown;
  has_more?: unknown;
}>;

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function sanitizeActorHeaderName(rawName: string): string {
  return (
    rawName
      .replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f]/g,
        ' ',
      )
      .trim()
      .slice(0, 120) || 'Continuum user'
  );
}

@Injectable()
export class AiChatService {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly projects: ProjectService,
    @Inject(AI_ENGINE_CLIENT) private readonly aiEngine: AiEngineClient,
  ) {}

  private async resolveSagSession(
    headers: AiChatRequestHeaders,
    projectId: string,
  ): Promise<{ agentId: string; bearerHeaders: Record<string, string> }> {
    const actor = await this.auth.getCurrentIdentity(
      headers.authorization,
      headers.cookie,
    );
    const project = await this.projects.get(actor, projectId);

    const loginResult = await this.aiEngine.request<SagLoginResponse>({
      path: '/api/v1/auth/continuum-login',
      method: 'POST',
      headers: {
        'X-Continuum-User-Id': actor.id,
        'X-Continuum-Name': sanitizeActorHeaderName(actor.name),
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

    return { agentId, bearerHeaders };
  }

  async listThreads(
    headers: AiChatRequestHeaders,
    projectId: string,
    query: Readonly<{ limit: number; offset: number }>,
  ): Promise<AiChatThreadDto[]> {
    const { agentId, bearerHeaders } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const params = new URLSearchParams({
      limit: String(query.limit),
      offset: String(query.offset),
    });
    const result = await this.aiEngine.request<unknown>({
      path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads?${params.toString()}`,
      method: 'GET',
      headers: bearerHeaders,
    });

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
    const { agentId, bearerHeaders } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const result = await this.aiEngine.request<unknown>({
      path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads`,
      method: 'POST',
      headers: bearerHeaders,
      body: { title: input.title ?? 'New chat' },
    });

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
    const { agentId, bearerHeaders } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const result = await this.aiEngine.request<unknown>({
      path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`,
      method: 'PATCH',
      headers: bearerHeaders,
      body: { title: input.title },
    });

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
    const { agentId, bearerHeaders } = await this.resolveSagSession(
      headers,
      projectId,
    );
    await this.aiEngine.request<unknown>({
      path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`,
      method: 'DELETE',
      headers: bearerHeaders,
    });
  }

  async listMessages(
    headers: AiChatRequestHeaders,
    projectId: string,
    threadId: string,
    query: Readonly<{ limit: number; cursor?: string }>,
  ): Promise<AiChatMessagePageDto> {
    const { agentId, bearerHeaders } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const params = new URLSearchParams({
      limit: String(query.limit),
    });
    if (query.cursor) {
      params.set('cursor', query.cursor);
    }
    const result = await this.aiEngine.request<SagMessagePageResponse>({
      path: `/api/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages?${params.toString()}`,
      method: 'GET',
      headers: bearerHeaders,
    });

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
    const { agentId, bearerHeaders } = await this.resolveSagSession(
      headers,
      projectId,
    );
    const upstream = await this.aiEngine.requestStream({
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

    const aiEngine = this.aiEngine;
    async function* enrichedStream(): AsyncGenerator<AiChatSseFrame> {
      for await (const frame of transformSagSseStream(upstream.stream, {
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
}
