import 'dotenv/config';
import { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Transport } from '@nestjs/microservices';

export async function bootstrapService(
  serviceModule: Type<unknown>,
): Promise<void> {
  const app = await NestFactory.create(serviceModule);
  const config = app.get(ConfigService);
  app.setGlobalPrefix('internal');
  app.connectMicroservice({
    transport: Transport.REDIS,
    options: {
      host: config.get<string>('REDIS_HOST') ?? '127.0.0.1',
      port: config.get<number>('REDIS_PORT') ?? 6379,
      password: config.get<string>('REDIS_PASSWORD') || undefined,
    },
  });

  await app.startAllMicroservices();
  await app.listen(config.get<number>('SERVICE_PORT') ?? 3001);
}
