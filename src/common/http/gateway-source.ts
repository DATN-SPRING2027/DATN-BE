import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const proofWindowMs = 60_000;

function signature(ip: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`iam-login-source\n${ip}\n${timestamp}`)
    .digest('hex');
}

export function signGatewaySource(
  ip: string,
  secret: string,
  now = Date.now(),
): Record<string, string> {
  if (!isIP(ip) || secret.length < 32) {
    throw new Error('Gateway login source configuration is invalid');
  }
  const timestamp = String(now);
  return {
    'x-iam-source-ip': ip,
    'x-iam-source-timestamp': timestamp,
    'x-iam-source-signature': signature(ip, timestamp, secret),
  };
}

export function verifyGatewaySource(
  headers: Record<string, unknown>,
  secret: string,
  now = Date.now(),
): string | null {
  const ip = headers['x-iam-source-ip'];
  const timestamp = headers['x-iam-source-timestamp'];
  const supplied = headers['x-iam-source-signature'];
  if (
    typeof ip !== 'string' ||
    !isIP(ip) ||
    typeof timestamp !== 'string' ||
    !/^\d{13}$/.test(timestamp) ||
    typeof supplied !== 'string' ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    secret.length < 32 ||
    Math.abs(now - Number(timestamp)) > proofWindowMs
  )
    return null;

  const expected = Buffer.from(signature(ip, timestamp, secret), 'hex');
  const received = Buffer.from(supplied, 'hex');
  return timingSafeEqual(expected, received) ? ip : null;
}
