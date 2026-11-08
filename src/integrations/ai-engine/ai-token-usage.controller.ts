import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AiTokenUsageService } from './ai-token-usage.service';
import type { AiChatRequestHeaders } from './ai-chat.types';
import type { AiTokenUsageResponseDto } from './ai-token-usage.types';

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

@Controller('ai-chat/token-usage')
export class AiTokenUsageController {
  constructor(private readonly tokenUsage: AiTokenUsageService) {}

  @Get()
  async getTokenUsage(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Query() query?: Record<string, unknown>,
  ): Promise<AiTokenUsageResponseDto> {
    response.setHeader('Cache-Control', 'no-store');
    const allowedKeys = new Set(['scope', 'projectId']);
    const unknownKeys = Object.keys(query ?? {}).filter(
      (key) => !allowedKeys.has(key),
    );
    if (unknownKeys.length > 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Unexpected query parameters.',
      });
    }
    if (
      (query?.scope !== undefined && typeof query.scope !== 'string') ||
      (query?.projectId !== undefined && typeof query.projectId !== 'string')
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Query parameters must be single string values.',
      });
    }

    const headers: AiChatRequestHeaders = {
      authorization: headerValue(request.headers.authorization),
      cookie: headerValue(request.headers.cookie),
      csrfToken: headerValue(request.headers['x-csrf-token']),
      organizationId: headerValue(request.headers['x-organization-id']),
      requestId: headerValue(request.headers['x-request-id']),
    };

    return this.tokenUsage.getTokenUsage(headers, {
      scope: typeof query?.scope === 'string' ? query.scope : undefined,
      projectId:
        typeof query?.projectId === 'string' ? query.projectId : undefined,
    });
  }
}
