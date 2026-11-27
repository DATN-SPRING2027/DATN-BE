import 'dotenv/config';
import './common/observability/register-otel';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { configureApplication } from './bootstrap';
import { ConfigService } from '@nestjs/config';
import { closeSharedHttpRedisConnections } from './common/redis/redis-connection';
import { monolithIamServiceUrl } from './monolith-configuration';

async function bootstrap() {
  process.env.CONTINUUM_RUNTIME_MODE = 'monolith';
  process.env.IAM_SERVICE_URL = monolithIamServiceUrl(process.env);
  // ConfigModule validates defaults while AppModule loads; set the monolith URL first.
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const trustedProxyCidrs = (
    config.get<string>('GATEWAY_TRUSTED_PROXY_CIDRS') ?? ''
  )
    .split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean);
  if (
    config.get<string>('NODE_ENV') === 'production' &&
    trustedProxyCidrs.length === 0
  ) {
    throw new Error('GATEWAY_TRUSTED_PROXY_CIDRS is required in production');
  }
  configureApplication(app, trustedProxyCidrs);

  const cleanup = () => {
    closeSharedHttpRedisConnections();
  };
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);

  const port = process.env.PORT || 3001;
  await app.listen(port);
}

void bootstrap();
