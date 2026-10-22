import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ChatIamClient } from '../application/chat-iam.client';
import { RedisService } from '../infrastructure/redis/redis.service';

@Injectable()
export class ChatTrafficGuard implements CanActivate {
  constructor(
    private readonly iam: ChatIamClient,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const actor = await this.iam.getActor({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    const prefix = this.config.get<string>('BULLMQ_PREFIX') ?? 'continuum';
    const read = request.method === 'GET';
    if (
      !(await this.redis.consumeRateLimit(
        `${prefix}:chat:http:${actor.organizationId}:${actor.id}:${read ? 'read' : 'write'}`,
        read ? 600 : 180,
        60,
      ))
    ) {
      throw new HttpException(
        {
          code: 'CHAT_RATE_LIMITED',
          message: 'Too many chat requests. Try again shortly.',
        },
        429,
      );
    }
    return true;
  }
}
