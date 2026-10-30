import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PlatformAuthorizationGuard } from '../../services/iam/application/authorization/platform-authorization.guard';
import { RequirePlatformPermission } from '../../services/iam/application/authorization/platform-permission.decorator';
import { AiChatService } from './ai-chat.service';
import type {
  AiChatFeedbackRating,
  PlatformAiFeedbackQueryDto,
} from './ai-chat.types';

const SAFE_FILTER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_CURSOR_PATTERN = /^[A-Za-z0-9_.-]{1,1024}$/;
const ISO_UTC_OFFSET_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ALLOWED_QUERY_KEYS = new Set([
  'organizationId',
  'projectId',
  'rating',
  'from',
  'to',
  'cursor',
  'limit',
]);

function invalidQuery(message: string): never {
  throw new BadRequestException({
    code: 'VALIDATION_FAILED',
    message,
  });
}

function readSingleQueryString(
  query: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    invalidQuery(`Query parameter ${key} must be a single string value.`);
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed !== raw) {
    invalidQuery(
      `Query parameter ${key} cannot be blank or have outer whitespace.`,
    );
  }
  return trimmed;
}

function parseIsoUtcTimestamp(
  raw: string | undefined,
  field: string,
): { iso: string; ms: number } | undefined {
  if (raw === undefined) return undefined;
  if (!ISO_UTC_OFFSET_PATTERN.test(raw)) {
    invalidQuery(
      `Query parameter ${field} must be an ISO-8601 date-time with UTC offset.`,
    );
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    invalidQuery(`Query parameter ${field} is not a valid date-time.`);
  }
  return { iso: new Date(ms).toISOString(), ms };
}

function parsePlatformAiFeedbackQuery(
  query: Record<string, unknown>,
): PlatformAiFeedbackQueryDto {
  for (const key of Object.keys(query)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      invalidQuery(`Unsupported query parameter: ${key}.`);
    }
  }

  const organizationId = readSingleQueryString(query, 'organizationId');
  if (
    organizationId !== undefined &&
    !SAFE_FILTER_ID_PATTERN.test(organizationId)
  ) {
    invalidQuery('organizationId filter is invalid.');
  }

  const projectId = readSingleQueryString(query, 'projectId');
  if (projectId !== undefined && !SAFE_FILTER_ID_PATTERN.test(projectId)) {
    invalidQuery('projectId filter is invalid.');
  }

  const ratingRaw = readSingleQueryString(query, 'rating');
  let rating: AiChatFeedbackRating | undefined;
  if (ratingRaw !== undefined) {
    if (ratingRaw !== 'LIKE' && ratingRaw !== 'DISLIKE') {
      invalidQuery('rating must be LIKE or DISLIKE.');
    }
    rating = ratingRaw;
  }

  const fromParsed = parseIsoUtcTimestamp(
    readSingleQueryString(query, 'from'),
    'from',
  );
  const toParsed = parseIsoUtcTimestamp(
    readSingleQueryString(query, 'to'),
    'to',
  );
  if (fromParsed && toParsed && fromParsed.ms >= toParsed.ms) {
    invalidQuery('from must be strictly earlier than to.');
  }

  const cursor = readSingleQueryString(query, 'cursor');
  if (cursor !== undefined && !SAFE_CURSOR_PATTERN.test(cursor)) {
    invalidQuery('cursor is invalid.');
  }

  const limitRaw = readSingleQueryString(query, 'limit');
  let limit = 20;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw)) {
      invalidQuery('limit must be an integer between 1 and 100.');
    }
    const parsedLimit = Number(limitRaw);
    if (
      !Number.isSafeInteger(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > 100
    ) {
      invalidQuery('limit must be an integer between 1 and 100.');
    }
    limit = parsedLimit;
  }

  return {
    ...(organizationId ? { organizationId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(rating ? { rating } : {}),
    ...(fromParsed ? { from: fromParsed.iso } : {}),
    ...(toParsed ? { to: toParsed.iso } : {}),
    ...(cursor ? { cursor } : {}),
    limit,
  };
}

@Controller('platform/ai')
@UseGuards(PlatformAuthorizationGuard)
export class PlatformAiFeedbackController {
  constructor(private readonly aiChat: AiChatService) {}

  @Get('feedback')
  @RequirePlatformPermission('platform.ai.operations.read')
  async listFeedback(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.aiChat.listPlatformFeedback(
      parsePlatformAiFeedbackQuery(query),
    );
  }
}
