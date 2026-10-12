import {
  classifyGoogleOAuthError,
  createGoogleOAuthRequestId,
  logGoogleOAuthStage,
} from './google-oauth.observability';
import type { GoogleOAuthLogSink } from './google-oauth.observability';

describe('Google OAuth observability', () => {
  it('accepts only UUID request IDs and creates a safe fallback', () => {
    const requestId = 'b127a512-4b27-4a62-96a3-587ae4d2e4b0';

    expect(createGoogleOAuthRequestId(requestId)).toBe(requestId);
    expect(createGoogleOAuthRequestId('bad\nrequest-id')).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
  });

  it('writes only structured allowlisted fields and never serializes caller data', () => {
    const lines: string[] = [];
    const warnings: string[] = [];
    const logger: GoogleOAuthLogSink = {
      log: (line) => lines.push(line),
      warn: (line) => warnings.push(line),
    };

    logGoogleOAuthStage(
      {
        requestId: 'b127a512-4b27-4a62-96a3-587ae4d2e4b0',
        stage: 'user_persistence',
        status: 'failed',
        errorCode: 'MONGOOSE_VALIDATION_ERROR',
      },
      logger,
    );

    expect(warnings).toHaveLength(1);
    expect(lines).toHaveLength(0);
    const line = warnings[0];
    expect(line).toBeDefined();
    expect(JSON.parse(line)).toEqual({
      event: 'google_oauth.callback',
      requestId: 'b127a512-4b27-4a62-96a3-587ae4d2e4b0',
      stage: 'user_persistence',
      status: 'failed',
      errorCode: 'MONGOOSE_VALIDATION_ERROR',
    });
    expect(line).not.toMatch(
      /authorization|access.?token|id.?token|cookie|secret|email/i,
    );
  });

  it('sanitizes invalid stage and error-code labels before writing a log line', () => {
    const lines: string[] = [];
    const logger: GoogleOAuthLogSink = {
      log: (line) => lines.push(line),
      warn: (line) => lines.push(line),
    };

    logGoogleOAuthStage(
      {
        requestId: 'b127a512-4b27-4a62-96a3-587ae4d2e4b0',
        stage: 'callback\n"private":"value"',
        status: 'failed',
        errorCode: 'SECRET VALUE\n',
      },
      logger,
    );

    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ stage: 'unknown' });
    expect(JSON.parse(lines[0] ?? '{}')).not.toHaveProperty('errorCode');
    expect(lines[0]).not.toContain('private');
  });

  it('maps database and redirect errors to stable codes without returning raw messages', () => {
    const validationError = Object.assign(
      new Error('sensitive validation detail'),
      {
        name: 'ValidationError',
      },
    );
    const redirectError = Object.assign(new Error('redirect_uri_mismatch'), {
      response: { data: { error: 'redirect_uri_mismatch' } },
    });

    expect(classifyGoogleOAuthError(validationError, 'CALLBACK_FAILED')).toBe(
      'MONGOOSE_VALIDATION_ERROR',
    );
    expect(classifyGoogleOAuthError({ code: 11000 }, 'CALLBACK_FAILED')).toBe(
      'MONGO_DUPLICATE_KEY',
    );
    expect(classifyGoogleOAuthError(redirectError, 'CALLBACK_FAILED')).toBe(
      'GOOGLE_REDIRECT_URI_MISMATCH',
    );
  });
});
