import '../common/observability/register-otel';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { GatewayModule } from './gateway.module';
import {
  configureApplication,
  configureSwagger,
  resolveCorsAllowedOrigins,
} from '../bootstrap';
import { closeSharedHttpRedisConnections } from '../common/redis/redis-connection';

async function bootstrap() {
  const app = await NestFactory.create(GatewayModule);
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

  configureApplication(
    app,
    trustedProxyCidrs,
    resolveCorsAllowedOrigins({
      corsAllowedOrigins: config.get<string>('CORS_ALLOWED_ORIGINS'),
      continuumWebBaseUrl: config.get<string>('CONTINUUM_WEB_BASE_URL'),
      webAppUrl: config.get<string>('WEB_APP_URL'),
      sagWebBaseUrl: config.get<string>('SAG_WEB_BASE_URL'),
    }),
  );

  if (config.getOrThrow<boolean>('SWAGGER_ENABLED')) {
    configureSwagger(app);
  }

  const cleanup = () => {
    closeSharedHttpRedisConnections();
  };
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);

  await app.listen(config.getOrThrow<number>('GATEWAY_PORT'));
}

void bootstrap();
