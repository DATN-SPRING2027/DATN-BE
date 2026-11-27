import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from './request-id.middleware';

type RecordValue = Record<string, unknown>;
type RequestWithId = Request & { requestId?: string };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function isMcpRequestPath(request: Request | undefined): boolean {
  const rawUrl = request?.originalUrl ?? request?.url ?? '';
  const pathname = trimTrailingSlashes(rawUrl.split('?')[0] ?? '');
  return pathname === '/api/v1/mcp' || pathname === '/internal/mcp';
}

function isBodyParseException(
  exception: unknown,
  status: number,
  body: RecordValue | undefined,
  message: string,
): boolean {
  if (exception instanceof SyntaxError) {
    return true;
  }
  if (
    isRecord(exception) &&
    (exception.type === 'entity.parse.failed' ||
      exception.cause instanceof SyntaxError)
  ) {
    return true;
  }
  return (
    status === 400 &&
    typeof body?.code !== 'string' &&
    /JSON|Unexpected token|Unexpected end|Expected\s+['",}\]]|position\s+\d+/i.test(
      message,
    )
  );
}

@Catch()
export class StructuredExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<Response>();
    if (response.headersSent) {
      if (!response.writableEnded) {
        response.end();
      }
      return;
    }
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : exception instanceof SyntaxError
          ? HttpStatus.BAD_REQUEST
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

    if (isMcpRequestPath(request)) {
      if (status === 401) {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('WWW-Authenticate', 'Bearer realm="continuum-mcp"');
        response.status(HttpStatus.UNAUTHORIZED).json({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32001,
            message: 'Authentication required.',
          },
        });
        return;
      }

      if (isBodyParseException(exception, status, body, message)) {
        response.setHeader('Cache-Control', 'no-store');
        response.status(HttpStatus.BAD_REQUEST).json({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error: Invalid JSON payload.',
          },
        });
        return;
      }
    }
    const requestId =
      request.requestId ??
      response.getHeader(REQUEST_ID_HEADER)?.toString() ??
      'unknown';
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${status}`;

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
