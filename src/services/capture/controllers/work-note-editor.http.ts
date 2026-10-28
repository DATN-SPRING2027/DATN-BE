import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import {
  readCookie,
  validCsrfPair,
} from '../../iam/application/authentication/authentication.application.service';
import type { CaptureRequestHeaders } from '../application/work-notes.types';
export function captureDraftHeaders(
  request: Request,
  mutation = false,
): CaptureRequestHeaders {
  request.res?.setHeader('Cache-Control', 'private, no-store');

  const get = (name: string) =>
    typeof request.headers[name] === 'string'
      ? request.headers[name]
      : undefined;
  const headers = {
    authorization: get('authorization'),
    cookie: get('cookie'),
    csrfToken: get('x-csrf-token'),
    organizationId: get('x-organization-id'),
    requestId: get('x-request-id'),
  };
  if (
    mutation &&
    !/^bearer\s+\S+/i.test(headers.authorization ?? '') &&
    headers.cookie?.trim()
  ) {
    const token =
      readCookie(headers.cookie, '__Host-csrf') ??
      readCookie(headers.cookie, 'continuum_csrf') ??
      readCookie(headers.cookie, 'csrf_token');
    if (!validCsrfPair(token, headers.csrfToken?.trim() ?? ''))
      throw new ForbiddenException({ code: 'CSRF_INVALID' });
  }
  return headers;
}
