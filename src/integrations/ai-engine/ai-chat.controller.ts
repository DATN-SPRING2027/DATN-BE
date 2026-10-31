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
  Put,
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
import {
  AI_CHAT_FEEDBACK_REASON_CATEGORIES,
  type AiChatFeedbackInputDto,
  type AiChatFeedbackReasonCategory,
  type AiChatMindMapInputDto,
  type AiChatRequestHeaders,
  type AiChatSseFrame,
} from './ai-chat.types';

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

function validateEmptyBody(body: unknown): void {
  if (!isPlainRecord(body) || Object.keys(body).length > 0) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Request body must be an empty JSON object.',
    });
  }
}

function validateGenerateMindMapBody(body: unknown): AiChatMindMapInputDto {
  if (body === undefined || body === null) return {};
  if (!isPlainRecord(body)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Request body must be a JSON object.',
    });
  }
  const unknownKeys = Object.keys(body).filter((key) => key !== 'topic');
  if (unknownKeys.length > 0) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Unexpected properties in request body.',
    });
  }
  if (body.topic === undefined || body.topic === null) return {};
  if (typeof body.topic !== 'string') {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'topic must be a string between 1 and 200 characters.',
    });
  }
  const normalized = body.topic.trim().replace(/\s+/g, ' ');
  if (normalized.length < 1 || normalized.length > 200) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'topic must be between 1 and 200 characters.',
    });
  }
  return { topic: normalized };
}

function validateFeedbackBody(body: unknown): AiChatFeedbackInputDto {
  if (!isPlainRecord(body)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Request body must be a JSON object.',
    });
  }
  const allowedKeys = new Set(['rating', 'reasonCategory', 'reasonText']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Unexpected properties in feedback body.',
    });
  }
  if (body.rating !== 'LIKE' && body.rating !== 'DISLIKE') {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'rating must be LIKE or DISLIKE.',
    });
  }

  if (body.rating === 'LIKE') {
    if (body.reasonCategory !== undefined || body.reasonText !== undefined) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'LIKE feedback cannot include reasonCategory or reasonText.',
      });
    }
    return { rating: 'LIKE' };
  }

  if (
    typeof body.reasonCategory !== 'string' ||
    !(AI_CHAT_FEEDBACK_REASON_CATEGORIES as readonly string[]).includes(
      body.reasonCategory,
    )
  ) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'DISLIKE feedback requires a valid reasonCategory.',
    });
  }
  const reasonCategory = body.reasonCategory as AiChatFeedbackReasonCategory;

  let reasonText: string | undefined;
  if (body.reasonText !== undefined) {
    if (
      typeof body.reasonText !== 'string' ||
      body.reasonText.length > 1000 ||
      !/\S/.test(body.reasonText)
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message:
          'reasonText must contain between 1 and 1000 non-whitespace characters.',
      });
    }
    reasonText = body.reasonText.trim();
  } else if (reasonCategory === 'OTHER') {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'reasonText is required when reasonCategory is OTHER.',
    });
  }

  return {
    rating: 'DISLIKE',
    reasonCategory,
    ...(reasonText ? { reasonText } : {}),
  };
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

    await this.pipeSseStream(response, (signal) =>
      this.aiChat.openAskStream(
        headers,
        validProjectId,
        validThreadId,
        dto,
        signal,
      ),
    );
  }

  @Get('threads/:threadId/messages/:messageId/feedback')
  async getOwnFeedback(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
    @Param('messageId') messageId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validThreadId = validatePathIdentifier(threadId, 'threadId');
    const validMessageId = validatePathIdentifier(messageId, 'messageId');
    return this.aiChat.getOwnFeedback(
      this.readHeaders(request),
      validProjectId,
      validThreadId,
      validMessageId,
    );
  }

  @Put('threads/:threadId/messages/:messageId/feedback')
  async putOwnFeedback(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validThreadId = validatePathIdentifier(threadId, 'threadId');
    const validMessageId = validatePathIdentifier(messageId, 'messageId');
    const dto = validateFeedbackBody(body);
    return this.aiChat.putOwnFeedback(
      this.mutationHeaders(request),
      validProjectId,
      validThreadId,
      validMessageId,
      dto,
    );
  }

  @Delete('threads/:threadId/messages/:messageId/feedback')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOwnFeedback(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validThreadId = validatePathIdentifier(threadId, 'threadId');
    const validMessageId = validatePathIdentifier(messageId, 'messageId');
    await this.aiChat.deleteOwnFeedback(
      this.mutationHeaders(request),
      validProjectId,
      validThreadId,
      validMessageId,
    );
  }

  @Post('threads/:threadId/messages/:messageId/shares')
  async createShare(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validThreadId = validatePathIdentifier(threadId, 'threadId');
    const validMessageId = validatePathIdentifier(messageId, 'messageId');
    validateEmptyBody(body);
    const created = await this.aiChat.createShare(
      this.mutationHeaders(request),
      validProjectId,
      validThreadId,
      validMessageId,
    );
    response.status(created.status);
    return created.share;
  }

  @Get('shares/:shareId')
  async readSharedAnswer(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Param('shareId') shareId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validShareId = validatePathIdentifier(shareId, 'shareId');
    return this.aiChat.readSharedAnswer(
      this.readHeaders(request),
      validProjectId,
      validShareId,
    );
  }

  @Delete('shares/:shareId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeShare(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Param('shareId') shareId: string,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validShareId = validatePathIdentifier(shareId, 'shareId');
    await this.aiChat.revokeShare(
      this.mutationHeaders(request),
      validProjectId,
      validShareId,
    );
  }

  @Post('mind-map')
  @HttpCode(HttpStatus.OK)
  async generateMindMap(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const input = validateGenerateMindMapBody(body);
    return this.aiChat.generateMindMap(
      this.mutationHeaders(request),
      validProjectId,
      input,
    );
  }

  @Post('threads/:threadId/messages/:messageId/regenerate')
  async regenerate(
    @Req() request: Request,
    @Res() response: Response,
    @Param('projectId') projectId: string,
    @Param('threadId') threadId: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const validProjectId = validatePathIdentifier(projectId, 'projectId');
    const validThreadId = validatePathIdentifier(threadId, 'threadId');
    const validMessageId = validatePathIdentifier(messageId, 'messageId');
    validateEmptyBody(body);
    const headers = this.mutationHeaders(request);

    await this.pipeSseStream(response, (signal) =>
      this.aiChat.openRegenerateStream(
        headers,
        validProjectId,
        validThreadId,
        validMessageId,
        signal,
      ),
    );
  }

  private async pipeSseStream(
    response: Response,
    openStream: (
      signal: AbortSignal,
    ) => Promise<AsyncGenerator<AiChatSseFrame>>,
  ): Promise<void> {
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
        eventStream = await openStream(abortController.signal);
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
