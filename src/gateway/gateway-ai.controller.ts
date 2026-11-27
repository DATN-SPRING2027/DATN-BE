import {
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Patch,
  Post,
  Put,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  buildSafeInternalProxyUrl,
  collectForwardedRequestHeaders,
  sendOrStreamUpstreamResponse,
} from './gateway-proxy.util';

const requestHeaders = [
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'sec-fetch-site',
  'x-csrf-token',
  'x-expected-organization-id',
  'x-organization-id',
  'x-request-id',
  'traceparent',
] as const;

const responseHeaders = [
  'cache-control',
  'content-type',
  'location',
  'referrer-policy',
  'retry-after',
  'www-authenticate',
  'x-accel-buffering',
  'x-request-id',
] as const;

/**
 * INFRA-003: Expose AI Chat (including SSE streams), Knowledge Universe,
 * Mind Map, AI Token Usage, SAG SSO, and Platform AI Feedback through GatewayModule.
 */
@Controller()
export class GatewayAiController {
  constructor(private readonly config: ConfigService) {}

  @Get('ai-chat/token-usage')
  getTokenUsage(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('ai-chat/projects/:projectId/document-sources')
  listDocumentSources(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('ai-chat/projects/:projectId/threads')
  listThreads(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('ai-chat/projects/:projectId/threads')
  createThread(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('ai-chat/projects/:projectId/threads/:threadId')
  renameThread(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Delete('ai-chat/projects/:projectId/threads/:threadId')
  deleteThread(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('ai-chat/projects/:projectId/threads/:threadId/messages')
  listMessages(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('ai-chat/projects/:projectId/threads/:threadId/ask')
  askStream(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response, { stream: true, llmTimeout: true });
  }

  @Post(
    'ai-chat/projects/:projectId/threads/:threadId/messages/:messageId/regenerate',
  )
  regenerateStream(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response, { stream: true, llmTimeout: true });
  }

  @Post(
    'ai-chat/projects/:projectId/threads/:threadId/messages/:messageId/branch',
  )
  branchThread(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(
    'ai-chat/projects/:projectId/threads/:threadId/messages/:messageId/feedback',
  )
  getFeedback(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put(
    'ai-chat/projects/:projectId/threads/:threadId/messages/:messageId/feedback',
  )
  putFeedback(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Delete(
    'ai-chat/projects/:projectId/threads/:threadId/messages/:messageId/feedback',
  )
  deleteFeedback(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(
    'ai-chat/projects/:projectId/threads/:threadId/messages/:messageId/shares',
  )
  createShare(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('ai-chat/projects/:projectId/shares/:shareId')
  readShare(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Delete('ai-chat/projects/:projectId/shares/:shareId')
  deleteShare(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('ai-chat/projects/:projectId/mind-map')
  getMindMap(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response, { llmTimeout: true });
  }

  @Post('ai-chat/projects/:projectId/mind-map')
  generateMindMap(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response, { llmTimeout: true });
  }

  @Get('ai-chat/projects/:projectId/knowledge-universe/overview')
  getUniverseOverview(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response, { llmTimeout: true });
  }

  @Get('ai-chat/projects/:projectId/knowledge-universe/cluster')
  getUniverseCluster(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response, { llmTimeout: true });
  }

  @Get('ai-chat/projects/:projectId/knowledge-universe/units/:unitId')
  getUniverseUnit(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response, { llmTimeout: true });
  }

  @Post('ai-chat/projects/:projectId/knowledge-universe/resolve')
  resolveUniverse(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response, { llmTimeout: true });
  }

  @Get('ai-engine/auth/sag-login')
  getSagLogin(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('ai-engine/auth/sag-login')
  postSagLogin(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('ai-engine/auth/sag-exchange')
  postSagExchange(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(
    'ai-engine/projects/:projectId/documents/:documentId/versions/:versionNo/status',
  )
  getDocumentStatus(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('ai-engine/projects/:projectId/conflicts')
  listProjectConflicts(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('ai-engine/projects/:projectId/conflicts/:resolutionId/resolve')
  resolveProjectConflict(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('ai-engine/projects/:projectId/conflicts/:resolutionId/reopen')
  reopenProjectConflict(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('platform/ai/feedback')
  listPlatformAiFeedback(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  private async forward(
    request: Request,
    response: Response,
    options: { stream?: boolean; llmTimeout?: boolean } = {},
  ): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    if (options.stream) {
      response.setHeader('x-accel-buffering', 'no');
    }
    const baseUrl =
      (typeof this.config.get === 'function'
        ? this.config.get<string>('AI_ENGINE_SERVICE_URL')
        : undefined) ?? this.config.getOrThrow<string>('IAM_SERVICE_URL');
    const targetUrl = buildSafeInternalProxyUrl(request.originalUrl, baseUrl);
    const headers = collectForwardedRequestHeaders(request, requestHeaders);
    const timeoutMs = options.llmTimeout
      ? ((typeof this.config.get === 'function'
          ? this.config.get<number>('SAG_CHAT_STREAM_TIMEOUT_MS')
          : undefined) ?? 120_000)
      : this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS');

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl, {
        method: request.method,
        headers,
        redirect: 'manual',
        ...(request.method === 'GET' ||
        request.method === 'HEAD' ||
        request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException('AI engine service timed out');
      }
      throw new ServiceUnavailableException('AI engine service unavailable');
    }

    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    const contentType = upstream.headers.get('content-type') ?? '';
    await sendOrStreamUpstreamResponse(upstream, response, {
      preferStream:
        Boolean(options.stream) || contentType.includes('text/event-stream'),
    });
  }
}
