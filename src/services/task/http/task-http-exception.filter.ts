import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../../../common/http/request-id.middleware';
import { StructuredExceptionFilter } from '../../../common/http/structured-exception.filter';
import { isObjectIdString } from '../infrastructure/mongodb/task-contract';
import { taskValidationFailedException } from '../runtime/task-authorization-http.errors';

const UNAUTHORIZED_STATUS = 401;
const SERVICE_UNAVAILABLE_STATUS = 503;
type TaskRequest = Request & { rawBody?: unknown; requestId?: string };

function isJsonMediaType(contentType: unknown): boolean {
  if (typeof contentType !== 'string') return false;
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  return (
    mediaType === 'application/json' ||
    /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)
  );
}

/** Nest converts Express's JSON SyntaxError into a BadRequestException. */
function isConfirmedJsonParseFailure(
  exception: unknown,
  request: TaskRequest,
): boolean {
  if (
    !(exception instanceof BadRequestException) ||
    exception.getStatus() !== 400 ||
    request.body !== undefined ||
    !Buffer.isBuffer(request.rawBody) ||
    !isJsonMediaType(request.headers['content-type'])
  ) {
    return false;
  }

  try {
    JSON.parse(request.rawBody.toString('utf8'));
    return false;
  } catch {
    return true;
  }
}

/** The taskId of an uncertain create outcome, the only 5xx detail the Task API exposes. */
function uncertainTaskId(exception: unknown): string | undefined {
  if (
    !(exception instanceof HttpException) ||
    exception.getStatus() !== SERVICE_UNAVAILABLE_STATUS
  ) {
    return undefined;
  }
  const body = exception.getResponse();
  if (typeof body !== 'object' || body === null) return undefined;
  const { code, details } = body as {
    code?: unknown;
    details?: { taskId?: unknown };
  };
  return code === 'TASK_CREATE_UNCERTAIN' && isObjectIdString(details?.taskId)
    ? details.taskId
    : undefined;
}

/**
 * CACHE-2 and HDR-1 (DATN-97 OpenAPI): every response of the Task routes is
 * `Cache-Control: no-store`, errors included, and every 401 carries
 * `WWW-Authenticate: Bearer`. Nest applies a handler's `@Header` values only
 * after the guard has run, so an authorization error thrown by the guard would
 * otherwise miss them; the headers are set here for every error, and the shared
 * `{code, message, details, requestId}` body is still written by
 * `StructuredExceptionFilter`.
 *
 * Registered on the Task controllers and, in the Task entrypoint, globally so
 * that an error raised before the route (a body that is not valid JSON, which
 * Nest reports as 400) also uses the Task shape: it is answered as 422
 * TASK_VALIDATION_FAILED, the only validation that precedes authorization.
 *
 * Create (DR7D-1): the shared filter answers `details` as an empty object for
 * every 5xx; for TASK_CREATE_UNCERTAIN only, this filter keeps
 * `details.taskId` so the client can resolve the outcome with the detail route.
 */
@Catch()
export class TaskHttpExceptionFilter implements ExceptionFilter {
  private readonly structured = new StructuredExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<TaskRequest>();
    response.setHeader('Cache-Control', 'no-store');

    const mapped = isConfirmedJsonParseFailure(exception, request)
      ? taskValidationFailedException(['the body is not valid JSON'])
      : exception;
    if (
      mapped instanceof HttpException &&
      mapped.getStatus() === UNAUTHORIZED_STATUS
    ) {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }

    const taskId = uncertainTaskId(mapped);
    if (taskId !== undefined) {
      const body = (mapped as HttpException).getResponse() as {
        code: string;
        message: string;
      };
      response.status(SERVICE_UNAVAILABLE_STATUS).json({
        code: body.code,
        message: body.message,
        details: { taskId },
        requestId:
          request.requestId ??
          response.getHeader(REQUEST_ID_HEADER)?.toString() ??
          'unknown',
      });
      return;
    }

    this.structured.catch(mapped, host);
  }
}
