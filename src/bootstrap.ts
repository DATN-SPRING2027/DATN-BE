import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import helmet from 'helmet';
import { requestIdMiddleware } from './common/http/request-id.middleware';
import { mcpKeyRestMutationGuardMiddleware } from './common/http/mcp-key-rest-guard.middleware';
import { StructuredExceptionFilter } from './common/http/structured-exception.filter';

const mcpPermissiveJsonParser = express.json({ strict: false, limit: '28mb' });

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function mcpBodyParserMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const rawUrl = req.originalUrl || req.url || '';
  const pathname = trimTrailingSlashes(rawUrl.split('?')[0] ?? '');
  if (pathname === '/api/v1/mcp' || pathname === '/internal/mcp') {
    mcpPermissiveJsonParser(req, res, next);
    return;
  }
  next();
}

export function resolveCorsAllowedOrigins(config: {
  corsAllowedOrigins?: string;
  continuumWebBaseUrl?: string;
  webAppUrl?: string;
}): string[] {
  const origins = new Set<string>();
  const addOrigin = (raw: string | undefined) => {
    const trimmed = raw?.trim();
    if (!trimmed) return;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        origins.add(parsed.origin);
      }
    } catch {
      // Ignored; env.validation already validates explicit origin entries.
    }
  };

  for (const entry of (config.corsAllowedOrigins ?? '').split(',')) {
    addOrigin(entry);
  }
  addOrigin(config.continuumWebBaseUrl);
  addOrigin(config.webAppUrl);

  if (origins.size === 0) {
    return ['http://localhost:3000', 'http://127.0.0.1:3000'];
  }
  return [...origins];
}

export function configureApplication(
  app: INestApplication,
  trustedProxyCidrs: string[] = [],
  corsAllowedOrigins: string[] = [],
): void {
  const expressApp = app.getHttpAdapter().getInstance() as Application;
  if (trustedProxyCidrs.length > 0) {
    expressApp.set('trust proxy', trustedProxyCidrs);
  }
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'internal/mcp', method: RequestMethod.ALL }],
  });
  app.use(requestIdMiddleware);
  app.use(mcpKeyRestMutationGuardMiddleware);
  app.use(mcpBodyParserMiddleware);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  const resolvedOrigins =
    corsAllowedOrigins.length > 0
      ? [...new Set(corsAllowedOrigins)]
      : ['http://localhost:3000', 'http://127.0.0.1:3000'];
  app.enableCors({
    origin: resolvedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'X-Organization-Id',
      'X-Request-Id',
      'If-Match',
      'Idempotency-Key',
      'Mcp-Session-Id',
      'MCP-Protocol-Version',
      'Last-Event-ID',
    ],
    exposedHeaders: [
      'ETag',
      'Location',
      'Idempotency-Replayed',
      'Retry-After',
      'Mcp-Session-Id',
      'MCP-Protocol-Version',
    ],
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
