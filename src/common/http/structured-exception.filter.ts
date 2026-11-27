import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from './request-id.middleware';

type RecordValue = Record<string, unknown>;
type RequestWithId = Request & { requestId?: string };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null;
}

function redactSecrets(input: string): string {
  return input
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(
      /(password|secret|token|apikey|api_key|authorization|cookie)\s*[:=]\s*[^\s,;}"']+/gi,
      '$1=[REDACTED]',
    )
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'`]+/gi, 'mongodb://[REDACTED]');
}

function sanitizePath(rawPath: string | undefined): string {
  if (!rawPath) return 'unknown';
  const withoutQuery = rawPath.split('?')[0] ?? rawPath;
  return withoutQuery.slice(0, 256);
}

@Catch()
export class StructuredExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(StructuredExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionBody =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const body = isRecord(exceptionBody) ? exceptionBody : undefined;
    const rawMessage = body?.message;
    const message = Array.isArray(rawMessage)
      ? 'Request validation failed'
      : typeof rawMessage === 'string'
        ? rawMessage
        : status >= 500
          ? 'Internal server error'
          : 'Request failed';
    const requestId =
      request.requestId ??
      response.getHeader(REQUEST_ID_HEADER)?.toString() ??
      'unknown';
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${status}`;

    if (status >= 500) {
      const errorObj = exception instanceof Error ? exception : undefined;
      const logPayload = {
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'http_unhandled_exception',
        requestId,
        method: request.method ?? 'UNKNOWN',
        path: sanitizePath(request.originalUrl ?? request.url),
        status,
        code,
        errorName: errorObj?.name ?? typeof exception,
        message: redactSecrets(
          errorObj?.message ??
            (typeof exception === 'string' ? exception : 'Unhandled exception'),
        ),
        ...(errorObj?.stack ? { stack: redactSecrets(errorObj.stack) } : {}),
      };
      this.logger.error(JSON.stringify(logPayload));
    }

    if (response.headersSent) {
      if (!response.writableEnded) {
        response.end();
      }
      return;
    }

    if (code === 'RETRY_LATER') response.setHeader('Retry-After', '1');

    response.status(status).json({
      code,
      message,
      details:
        status >= 500
          ? {}
          : Array.isArray(rawMessage)
            ? { messages: rawMessage }
            : (body?.details ?? {}),
      requestId,
    });
  }
}
