import { signGatewaySource, verifyGatewaySource } from './gateway-source';

const secret = 'test-gateway-secret-at-least-32-characters';

describe('Gateway source proof', () => {
  it('accepts a signed client IP across a non-loopback service boundary', () => {
    const headers = signGatewaySource('203.0.113.7', secret, 1_700_000_000_000);
    expect(verifyGatewaySource(headers, secret, 1_700_000_000_000)).toBe(
      '203.0.113.7',
    );
  });

  it('rejects forged IPs, expired proofs and malformed addresses', () => {
    const headers = signGatewaySource('203.0.113.7', secret, 1_700_000_000_000);
    expect(
      verifyGatewaySource(
        { ...headers, 'x-iam-source-ip': '203.0.113.8' },
        secret,
        1_700_000_000_000,
      ),
    ).toBeNull();
    expect(verifyGatewaySource(headers, secret, 1_700_000_061_000)).toBeNull();
    expect(
      verifyGatewaySource(
        { ...headers, 'x-iam-source-ip': 'not-ip' },
        secret,
        1_700_000_000_000,
      ),
    ).toBeNull();
  });
});
