import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../infrastructure/redis/redis.service';

const HISTORY_VERSION_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class ChatHistoryCacheInvalidator {
  private readonly redisPrefix: string;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.redisPrefix = `${config.get<string>('BULLMQ_PREFIX') ?? 'continuum'}:chat`;
  }

  historyVersionKey(organizationId: string, conversationId: string): string {
    return `${this.redisPrefix}:history-version:${organizationId}:${conversationId}`;
  }

  async getVersion(
    organizationId: string,
    conversationId: string,
  ): Promise<string> {
    try {
      return (
        (await this.redis.get(
          this.historyVersionKey(organizationId, conversationId),
        )) ?? '0'
      );
    } catch {
      return '0';
    }
  }

  async invalidate(
    organizationId: string,
    conversationId: string,
  ): Promise<void> {
    try {
      await this.redis.increment(
        this.historyVersionKey(organizationId, conversationId),
        HISTORY_VERSION_TTL_SECONDS,
      );
    } catch {
      // Cached pages expire quickly; persistent writes must not fail on Redis errors.
    }
  }
}
