import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { GatewayModule } from './gateway.module';
import { configureApplication, configureSwagger } from '../bootstrap';

async function bootstrap() {
  const app = await NestFactory.create(GatewayModule);
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

  if (config.getOrThrow<boolean>('SWAGGER_ENABLED')) {
    configureSwagger(app);
  }

  await app.listen(config.getOrThrow<number>('GATEWAY_PORT'));
}

void bootstrap();
