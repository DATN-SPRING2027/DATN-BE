import {
  canonicalizePayload,
  type PlatformAuthorityChangePayload,
} from './platform-authority-change.types';

describe('platform authority change payload canonicalization', () => {
  const payload: PlatformAuthorityChangePayload = {
    operationType: 'REVOKE',
    targetUserId: '507f1f77bcf86cd799439011',
    permission: 'organization.create',
    scope: 'PLATFORM',
    actorUserId: '507f1f77bcf86cd799439012',
    issuerUserId: '507f1f77bcf86cd799439013',
    reasonCode: 'TEST',
  };

  it('preserves legacy default-false hashes and ignores untrusted breakGlass input', () => {
    const canonical = canonicalizePayload(payload);
    const legacyDefault = canonicalizePayload({
      ...payload,
      breakGlass: false,
    } as PlatformAuthorityChangePayload);
    const untrustedOverride = canonicalizePayload({
      ...payload,
      breakGlass: true,
    } as PlatformAuthorityChangePayload);

    expect(canonical).toBe(legacyDefault);
    expect(untrustedOverride).toBe(canonical);
  });
});
