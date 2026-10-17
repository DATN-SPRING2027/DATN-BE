import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { verifyGatewaySource } from '../../../common/http/gateway-source';

export function ensureTrustedLoginSource(
  request: Request,
  config: ConfigService,
): string {
  const sourceIp = request.originalUrl.startsWith('/internal/')
    ? (verifyGatewaySource(
        request.headers,
        config.get<string>('IAM_GATEWAY_SECRET') ?? '',
      ) ?? '')
    : (request.ip ?? request.socket.remoteAddress ?? 'unknown');
  if (!sourceIp) {
    throw new UnauthorizedException({
      code: 'INVALID_GATEWAY_SOURCE',
      message: 'Gateway source proof is invalid.',
    });
  }
  return sourceIp;
}
