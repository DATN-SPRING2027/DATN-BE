import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class IdempotencyService {
  constructor(private readonly redis: RedisService) {}

  claim(key: string, ttlSeconds: number): Promise<boolean> {
    return this.redis.setIfAbsent(key, '1', ttlSeconds);
  }
}
