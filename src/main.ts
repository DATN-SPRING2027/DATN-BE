import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApplication, configureSwagger } from './bootstrap';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  configureApplication(app);

  if (config.getOrThrow<boolean>('SWAGGER_ENABLED')) {
    configureSwagger(app);
  }

  await app.listen(config.getOrThrow<number>('PORT'));
}

void bootstrap();
