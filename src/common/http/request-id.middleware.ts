import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

type RequestWithId = Request & { requestId?: string };

const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

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

  request.requestId = requestId;
  response.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
