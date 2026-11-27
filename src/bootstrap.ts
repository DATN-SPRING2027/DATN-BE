import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { Application, NextFunction, Request, Response } from 'express';
import { requestIdMiddleware } from './common/http/request-id.middleware';
import { StructuredExceptionFilter } from './common/http/structured-exception.filter';

const httpAccessLogger = new Logger('HttpAccess');

/**
 * OBS-004: Lightweight structured JSON HTTP access logger.
 * Strips query parameters so sensitive OAuth/verification/reset tokens never enter stdout logs.
 */
function httpAccessLogMiddleware(
  req: Request & { requestId?: string },
  res: Response,
  next: NextFunction,
): void {
  if (process.env.NODE_ENV === 'test') {
    next();
    return;
  }
  const startedAt = Date.now();
  res.on('finish', () => {
    const rawPath = (req.originalUrl ?? req.url ?? '/').split('?')[0];
    httpAccessLogger.log(
      JSON.stringify({
        event: 'http_request',
        timestamp: new Date().toISOString(),
        requestId: req.requestId ?? null,
        method: req.method,
        path: rawPath,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }),
    );
  });
  next();
}

export function resolveAllowedCorsOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = [
    ...(env.CORS_ALLOWED_ORIGINS ?? '').split(','),
    env.CONTINUUM_WEB_BASE_URL ?? '',
    env.SAG_WEB_BASE_URL ?? '',
  ]
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => {
      if (!origin) return false;
      try {
        const parsed = new URL(origin);
        return (
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.origin === origin
        );
      } catch {
        return false;
      }
    });

  if (configured.length > 0) {
    return [...new Set(configured)];
  }
  if (env.NODE_ENV === 'production') {
    return [];
  }
  return ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

export function configureApplication(
  app: INestApplication,
  trustedProxyCidrs: string[] = [],
): void {
  const expressApp = app.getHttpAdapter().getInstance() as Application;
  if (trustedProxyCidrs.length > 0) {
    expressApp.set('trust proxy', trustedProxyCidrs);
  }
  app.setGlobalPrefix('api/v1');
  app.use(requestIdMiddleware);
  app.use(httpAccessLogMiddleware);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  const allowedOrigins = resolveAllowedCorsOrigins();
  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'X-Expected-Organization-Id',
      'X-Organization-Id',
      'If-Match',
      'Idempotency-Key',
    ],
    exposedHeaders: ['ETag', 'Location', 'Idempotency-Replayed', 'Retry-After'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.useGlobalFilters(new StructuredExceptionFilter());
}

export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Continuum AI Backend API')
    .setDescription('Implemented HTTP contracts for Continuum AI backend-core.')
    .setVersion('0.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
}
