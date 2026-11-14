import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { sign, verify, type JwtPayload } from 'jsonwebtoken';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import { sagOperation } from '../application/platform/sag-operator';

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}
function httpsUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ServiceUnavailableException();
  return url;
}
@Controller('iam/platform/sag')
export class SagOperatorController {
  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthenticationApplicationService,
  ) {}
  private readonly log = new Logger('SagOperator');
  private setting(name: string) {
    const value = this.config.get<string>(name);
    if (!value)
      throw new ServiceUnavailableException(
        'SAG operator trust is not configured',
      );
    return value;
  }
  private scope() {
    return {
      instance: this.setting('SAG_OPERATOR_INSTANCE'),
      environment: this.setting('SAG_OPERATOR_ENVIRONMENT'),
    };
  }
  private signingKey() {
    return createPrivateKey(
      this.setting('SAG_OPERATOR_PRIVATE_KEY').replace(/\\n/g, '\n'),
    );
  }
  private mfa(proof: unknown, sub: string, sid: string) {
    if (typeof proof !== 'string' || proof.length > 8192)
      throw new ForbiddenException();
    const key = this.setting('SAG_MFA_PUBLIC_KEY').replace(/\\n/g, '\n');
    const issuer = this.setting('SAG_MFA_ISSUER');
    const window = Number(this.setting('SAG_MFA_MAX_AGE_SECONDS'));
    if (!Number.isSafeInteger(window) || window <= 0)
      throw new ServiceUnavailableException();
    let claims: JwtPayload;
    try {
      claims = verify(proof, key, {
        algorithms: ['RS256'],
        issuer,
        audience: 'continuum-sag-step-up',
      }) as JwtPayload;
    } catch {
      throw new ForbiddenException();
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.sub !== sub ||
      claims.sid !== sid ||
      !Array.isArray(claims.amr) ||
      !claims.amr.includes('mfa') ||
      typeof claims.auth_time !== 'number' ||
      !Number.isSafeInteger(claims.auth_time) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.auth_time > now ||
      claims.auth_time + window <= now
    )
      throw new ForbiddenException();
    return Math.min(claims.exp!, claims.auth_time + window);
  }

  @Post('operations/:action')
  @HttpCode(200)
  async execute(
    @Param('action') action: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { input?: unknown; stepUp?: string } | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!authorization) throw new UnauthorizedException();
    const op = sagOperation(action);
    const scope = this.scope();
    const session = await this.auth.authorizeSagOperation(
      authorization,
      op.permission,
      scope,
    );
    const requestId = randomUUID();
    const bff = this.setting('SAG_OPERATOR_BFF_CREDENTIAL');
    if (bff.length < 32) throw new ServiceUnavailableException();
    const mfaUntil = op.sensitive
      ? this.mfa(body?.stepUp, session.sub, session.sid)
      : undefined;
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.min(now + 300, session.exp, mfaUntil ?? Infinity);
    if (exp <= now) throw new ForbiddenException();
    const assertion = sign(
      {
        ...session,
        exp,
        ...scope,
        action,
        permission: op.permission,
        client_id: 'continuum-bff',
        cnf: { credential_sha256: digest(bff).toString('hex') },
        mfa_until: mfaUntil,
        jti: requestId,
      },
      this.signingKey(),
      {
        algorithm: 'RS256',
        issuer: this.setting('SAG_OPERATOR_ISSUER'),
        audience: 'sag-platform-operator',
        header: { alg: 'RS256', typ: 'sag-operator+jwt' },
      },
    );
    const target = httpsUrl(this.setting('SAG_OPERATOR_API_URL'));
    target.pathname = target.pathname.replace(/\/$/, '') + op.path;
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(target, {
        method: op.method,
        headers: {
          'content-type': 'application/json',
          'x-request-id': requestId,
          'x-sag-operator-assertion': assertion,
          'x-sag-operator-service': bff,
        },
        body:
          op.method === 'GET' || body?.input === undefined
            ? undefined
            : JSON.stringify(body.input),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      this.log.warn({
        requestId,
        actor: session.sub,
        ...scope,
        action,
        result: 'unavailable',
      });
      throw new ServiceUnavailableException();
    }
    this.log.log({
      requestId,
      actor: session.sub,
      service: 'continuum-bff',
      ...scope,
      action,
      status: upstream.status,
    });
    if (!upstream.ok) {
      response.status(upstream.status);
      return { code: 'SAG_OPERATION_FAILED', requestId };
    }
    return (await upstream.json()) as unknown;
  }

  @Post('decision')
  @HttpCode(200)
  async decide(
    @Headers('authorization') credential: string | undefined,
    @Body() body: { assertion?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const secret = this.setting('SAG_OPERATOR_DECISION_CREDENTIAL');
    if (
      secret.length < 32 ||
      !credential ||
      !timingSafeEqual(digest(credential), digest('Bearer ' + secret))
    )
      throw new ForbiddenException();
    let claims: JwtPayload;
    try {
      claims = verify(
        body?.assertion ?? '',
        createPublicKey(this.signingKey()),
        {
          algorithms: ['RS256'],
          issuer: this.setting('SAG_OPERATOR_ISSUER'),
          audience: 'sag-platform-operator',
        },
      ) as JwtPayload;
    } catch {
      throw new ForbiddenException();
    }
    const scope = this.scope();
    if (typeof claims.action !== 'string') throw new ForbiddenException();
    const op = sagOperation(claims.action);
    if (
      !op.sensitive ||
      claims.instance !== scope.instance ||
      claims.environment !== scope.environment ||
      claims.permission !== op.permission ||
      claims.client_id !== 'continuum-bff' ||
      !Number.isSafeInteger(claims.mfa_until) ||
      claims.mfa_until <= Date.now() / 1000
    )
      throw new ForbiddenException();
    await this.auth.recheckSagOperation(claims, op.permission, scope);
    return { allowed: true, jti: claims.jti, action: claims.action, ...scope };
  }
}
