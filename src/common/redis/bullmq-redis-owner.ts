import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRedisConnection, RedisConnection } from './redis-connection';

/** BullMQ treats injected Redis instances as shared and leaves shutdown to us. */
@Injectable()
export class BullMqRedisOwner implements OnApplicationShutdown {
  readonly client: RedisConnection;

  constructor(config: ConfigService) {
    this.client = createRedisConnection(config);
  }

  // Queue/worker onModuleDestroy hooks must finish before this shared client closes.
  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}
