import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';
export const TRACEPARENT_HEADER = 'traceparent';

type RequestWithId = Request & { requestId?: string; traceparent?: string };

const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;
const traceparentPattern = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;

function resolveTraceparent(incoming: string | undefined): string | undefined {
  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan?.spanContext();
  if (
    spanContext &&
    spanContext.traceId &&
    spanContext.spanId &&
    spanContext.traceId !== '00000000000000000000000000000000'
  ) {
    const flags = (spanContext.traceFlags ?? 1).toString(16).padStart(2, '0');
    return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
  }
  if (incoming && traceparentPattern.test(incoming.trim())) {
    return incoming.trim().toLowerCase();
  }
  return undefined;
}

export function requestIdMiddleware(
  request: RequestWithId,
  response: Response,
  next: NextFunction,
): void {
  const incomingRequestId = request.get(REQUEST_ID_HEADER);
  const requestId =
    incomingRequestId && requestIdPattern.test(incomingRequestId)
      ? incomingRequestId
      : randomUUID();
  const traceparent = resolveTraceparent(request.get(TRACEPARENT_HEADER));

  request.requestId = requestId;
  if (traceparent) {
    request.traceparent = traceparent;
  }
  response.setHeader(REQUEST_ID_HEADER, requestId);
  runWithRequestContext(
    () => {
      next();
    },
    { requestId, traceparent },
  );
}
