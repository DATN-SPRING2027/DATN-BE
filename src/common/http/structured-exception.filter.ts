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
