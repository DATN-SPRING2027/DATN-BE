import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';
import { StructuredExceptionFilter } from '../../../common/http/structured-exception.filter';

const UNAUTHORIZED_STATUS = 401;

/**
 * CACHE-2 and HDR-1 (DATN-97 OpenAPI): every response of the Task routes is
 * `Cache-Control: no-store`, errors included, and every 401 carries
 * `WWW-Authenticate: Bearer`. Nest applies a handler's `@Header` values only
 * after the guard has run, so an authorization error thrown by the guard would
 * otherwise miss them; the headers are set here for every error, and the shared
 * `{code, message, details, requestId}` body is still written by
 * `StructuredExceptionFilter`.
 */
@Catch()
export class TaskHttpExceptionFilter implements ExceptionFilter {
  private readonly structured = new StructuredExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (
      exception instanceof HttpException &&
      exception.getStatus() === UNAUTHORIZED_STATUS
    ) {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }
    this.structured.catch(exception, host);
  }
}
