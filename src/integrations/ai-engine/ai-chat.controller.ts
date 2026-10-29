import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  readCookie,
  validCsrfPair,
} from '../../services/iam/application/authentication/authentication.application.service';
import { AiChatService } from './ai-chat.service';
import type { AiChatRequestHeaders, AiChatSseFrame } from './ai-chat.types';

const SAFE_PATH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function validatePathIdentifier(value: string, fieldName: string): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !SAFE_PATH_ID_PATTERN.test(value)
  ) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${fieldName} is invalid.`,
    });
  }
  return value;
}

function parseBoundedInt(
  raw: string | undefined,
  options: { field: string; min: number; max: number; fallback: number },
): number {
  if (raw === undefined || raw === '') return options.fallback;
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${options.field} must be an integer between ${options.min} and ${options.max}.`,
    });
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < options.min ||
    parsed > options.max
  ) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${options.field} must be an integer between ${options.min} and ${options.max}.`,
    });
  }
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCreateThreadBody(body: unknown): { title?: string } {
  if (body === undefined || body === null) return {};
  if (!isPlainRecord(body)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Request body must be a JSON object.',
    });
  }
  const unknownKeys = Object.keys(body).filter((key) => key !== 'title');
  if (unknownKeys.length > 0) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Unexpected properties in request body.',
    });
  }
  if (body.title === undefined) return {};
  if (typeof body.title !== 'string') {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'title must be a string between 1 and 200 characters.',
    });
  }
  const trimmed = body.title.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'title must be between 1 and 200 characters.',
    });
  }
  return { title: trimmed };
}

function validateUpdateThreadBody(body: unknown): { title: string } {
  if (!isPlainRecord(body)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Request body must be a JSON object.',
    });
  }
  const unknownKeys = Object.keys(body).filter((key) => key !== 'title');
  if (unknownKeys.length > 0 || typeof body.title !== 'string') {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'title is required and must be a string.',
    });
  }
  const trimmed = body.title.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'title must be between 1 and 200 characters.',
    });
  }
  return { title: trimmed };
}

function validateAskBody(body: unknown): { query: string } {
  if (!isPlainRecord(body)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Request body must be a JSON object.',
    });
  }
  const unknownKeys = Object.keys(body).filter((key) => key !== 'query');
  if (unknownKeys.length > 0 || typeof body.query !== 'string') {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'query is required and must be a string.',
    });
  }
  const trimmed = body.query.trim();
  if (trimmed.length < 1 || trimmed.length > 4000) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'query must be between 1 and 4000 characters.',
    });
  }
  return { query: trimmed };
}

@Controller('ai-chat/projects/:projectId')
export class AiChatController {
  constructor(private readonly aiChat: AiChatService) {}

  @Get('threads')
  async listThreads(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const limit = parseBoundedInt(limitRaw, {
      field: 'limit',
      min: 1,
      max: 100,
      fallback: 20,
    });
    const offset = parseBoundedInt(offsetRaw, {
      field: 'offset',
      min: 0,
      max: 10000,
      fallback: 0,
    });
    return this.aiChat.listThreads(this.readHeaders(request), validProjectId, {
      limit,
      offset,
    });
  }

  @Post('threads')
  @HttpCode(HttpStatus.CREATED)
  async createThread(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const dto = validateCreateThreadBody(body);
    return this.aiChat.createThread(
      this.mutationHeaders(request),
      validProjectId,
      dto,
    );
  }

  @Patch('threads/:threadId')
  async updateThread(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validThreadId = validatePathIdentifier(threadId, 'threadId');
    const dto = validateUpdateThreadBody(body);
    return this.aiChat.updateThread(
      this.mutationHeaders(request),
      validProjectId,
      validThreadId,
      dto,
    );
  }

  @Delete('threads/:threadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteThread(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validThreadId = validatePathIdentifier(threadId, 'threadId');
    await this.aiChat.deleteThread(
      this.mutationHeaders(request),
      validProjectId,
      validThreadId,
    );
  }

  @Get('threads/:threadId/messages')
  async listMessages(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursorRaw?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validThreadId = validatePathIdentifier(threadId, 'threadId');
    const limit = parseBoundedInt(limitRaw, {
      field: 'limit',
      min: 1,
      max: 100,
      fallback: 40,
    });
    if (cursorRaw !== undefined && cursorRaw.length > 2048) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'cursor exceeds maximum length.',
      });
    }
    const cursor =
      cursorRaw && cursorRaw.trim().length > 0 ? cursorRaw.trim() : undefined;
    return this.aiChat.listMessages(
      this.readHeaders(request),
      validProjectId,
      validThreadId,
      { limit, cursor },
    );
  }

  @Post('threads/:threadId/ask')
  async ask(
    @Req() request: Request,
    @Res() response: Response,
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validThreadId = validatePathIdentifier(threadId, 'threadId');
    const dto = validateAskBody(body);
    const headers = this.mutationHeaders(request);

    const abortController = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) {
        abortController.abort();
      }
    };
    response.on('close', onClose);
    if (response.destroyed) {
      abortController.abort();
    }

    try {
      let eventStream: AsyncGenerator<AiChatSseFrame>;
      try {
        eventStream = await this.aiChat.openAskStream(
          headers,
          validProjectId,
          validThreadId,
          dto,
          abortController.signal,
        );
      } catch (error) {
        if (abortController.signal.aborted || response.destroyed) {
          return;
        }
        throw error;
      }

      if (
        abortController.signal.aborted ||
        response.destroyed ||
        response.writableEnded
      ) {
        await eventStream.return(undefined).catch(() => undefined);
        return;
      }

      response.status(HttpStatus.OK);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader(
        'Cache-Control',
        'no-cache, no-store, must-revalidate',
      );
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();

      try {
        for await (const frame of eventStream) {
          if (abortController.signal.aborted || response.writableEnded) {
            break;
          }
          response.write(
            `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`,
          );
        }
      } catch {
        if (!abortController.signal.aborted && !response.writableEnded) {
          response.write(
            `event: failed\ndata: ${JSON.stringify({
              code: 'STREAM_INTERRUPTED',
              message:
                'AI response stream ended unexpectedly. Please try again.',
              retryable: true,
            })}\n\n`,
          );
        }
      }
    } finally {
      response.off('close', onClose);
      if (response.headersSent && !response.writableEnded) {
        response.end();
      }
    }
  }

  private readHeaders(request: Request): AiChatRequestHeaders {
    return {
      authorization: headerValue(request.headers.authorization),
      cookie: headerValue(request.headers.cookie),
      csrfToken: headerValue(request.headers['x-csrf-token']),
      organizationId: headerValue(request.headers['x-organization-id']),
      requestId: headerValue(request.headers['x-request-id']),
    };
  }

  private mutationHeaders(request: Request): AiChatRequestHeaders {
    const headers = this.readHeaders(request);
    const hasBearer =
      typeof headers.authorization === 'string' &&
      /^bearer\s+\S+/i.test(headers.authorization.trim());
    if (
      !hasBearer &&
      typeof headers.cookie === 'string' &&
      headers.cookie.trim().length > 0
    ) {
      const cookieToken =
        readCookie(headers.cookie, '__Host-csrf') ??
        readCookie(headers.cookie, 'continuum_csrf') ??
        readCookie(headers.cookie, 'csrf_token');
      const csrfHeader =
        typeof headers.csrfToken === 'string' ? headers.csrfToken.trim() : '';
      if (!validCsrfPair(cookieToken, csrfHeader)) {
        throw new ForbiddenException({
          code: 'CSRF_INVALID',
          message: 'CSRF token is missing or invalid.',
        });
      }
    }
    return headers;
  }
}
