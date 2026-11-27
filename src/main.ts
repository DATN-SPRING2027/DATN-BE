import 'dotenv/config';
import './common/observability/register-otel';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { configureApplication, resolveCorsAllowedOrigins } from './bootstrap';
import { ConfigService } from '@nestjs/config';
import { monolithIamServiceUrl } from './monolith-configuration';

async function bootstrap() {
  process.env.IAM_SERVICE_URL = monolithIamServiceUrl(process.env);
  // ConfigModule validates defaults while AppModule loads; set the monolith URL first.
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.useWebSocketAdapter(new WsAdapter(app));

  const config = app.get(ConfigService);
  configureApplication(
    app,
    (config.get<string>('GATEWAY_TRUSTED_PROXY_CIDRS') ?? '')
      .split(',')
      .map((cidr) => cidr.trim())
      .filter(Boolean),
    resolveCorsAllowedOrigins({
      corsAllowedOrigins: config.get<string>('CORS_ALLOWED_ORIGINS'),
      continuumWebBaseUrl: config.get<string>('CONTINUUM_WEB_BASE_URL'),
      webAppUrl: config.get<string>('WEB_APP_URL'),
    }),
  );

  const port = process.env.PORT || 3001;
  await app.listen(port);
}

void bootstrap();
