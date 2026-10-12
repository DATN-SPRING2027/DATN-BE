import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export type GoogleOAuthLogStatus =
  'started' | 'succeeded' | 'failed' | 'skipped';

export interface GoogleOAuthLogEntry {
  requestId: string;
  stage: string;
  status: GoogleOAuthLogStatus;
  errorCode?: string;
}

export interface GoogleOAuthLogSink {
  log(message: string): void;
  warn(message: string): void;
}

const logger = new Logger('GoogleOAuth');
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeStagePattern = /^[a-z][a-z0-9_]{1,63}$/;
const safeCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/;

export function createGoogleOAuthRequestId(
  candidate: string | string[] | undefined,
): string {
  const value = Array.isArray(candidate) ? candidate[0] : candidate;
  return value && requestIdPattern.test(value) ? value : randomUUID();
}

export function logGoogleOAuthStage(
  entry: GoogleOAuthLogEntry,
  sink: GoogleOAuthLogSink = logger,
): void {
  const safeEntry = {
    event: 'google_oauth.callback',
    requestId: createGoogleOAuthRequestId(entry.requestId),
    stage: safeStagePattern.test(entry.stage) ? entry.stage : 'unknown',
    status: entry.status,
    ...(entry.errorCode && safeCodePattern.test(entry.errorCode)
      ? { errorCode: entry.errorCode }
      : {}),
  };
  const line = JSON.stringify(safeEntry);

  if (entry.status === 'failed') {
    sink.warn(line);
    return;
  }
  sink.log(line);
}

export function classifyGoogleOAuthError(
  error: unknown,
  fallbackCode: string,
): string {
  if (!error || typeof error !== 'object') return fallbackCode;

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    response?: { data?: { error?: unknown } };
  };
  if (candidate.name === 'ValidationError') return 'MONGOOSE_VALIDATION_ERROR';
  if (candidate.code === 11000 || candidate.code === '11000')
    return 'MONGO_DUPLICATE_KEY';

  const providerCode =
    typeof candidate.code === 'string'
      ? candidate.code
      : candidate.response?.data?.error;
  if (providerCode === 'redirect_uri_mismatch')
    return 'GOOGLE_REDIRECT_URI_MISMATCH';
  if (providerCode === 'invalid_grant')
    return 'GOOGLE_AUTHORIZATION_CODE_REJECTED';
  if (providerCode === 'invalid_client')
    return 'GOOGLE_OAUTH_CLIENT_CONFIGURATION_ERROR';

  return fallbackCode;
}
