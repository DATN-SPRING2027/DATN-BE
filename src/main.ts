import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApplication } from './bootstrap';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(ConfigService);
  configureApplication(
    app,
    (config.get<string>('GATEWAY_TRUSTED_PROXY_CIDRS') ?? '')
      .split(',')
      .map((cidr) => cidr.trim())
      .filter(Boolean),
  );

  const port = process.env.PORT || 3001;
  await app.listen(port);
}

void bootstrap();
