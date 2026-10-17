import {
  canonicalizeAssignmentSnapshot,
  canonicalizePayload,
  hashAssignmentSnapshot,
  type PlatformAuthorityChangePayload,
  type PlatformAuthoritySnapshotRow,
} from './platform-authority-change.types';

describe('Platform authority snapshot and payload canonicalization', () => {
  const snapshot: PlatformAuthoritySnapshotRow[] = [
    {
      assignmentId: '507f1f77bcf86cd799439011',
      permission: 'platform.health.read',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      grantedBy: '507f1f77bcf86cd799439012',
      expiresAt: null,
      revokedAt: null,
      revokedBy: null,
      provenanceOperationId: '00000000-0000-4000-8000-000000000001',
    },
  ];

  const payload: PlatformAuthorityChangePayload = {
    operationType: 'REVOKE',
    bundleVersion: 'A04',
    targetUserId: '507f1f77bcf86cd799439011',
    scope: 'PLATFORM',
    actorUserId: '507f1f77bcf86cd799439012',
    issuerUserId: '507f1f77bcf86cd799439013',
    expectedCurrentSnapshotHash: hashAssignmentSnapshot(snapshot),
    reasonCode: 'PO_AUTH_01_REVOKE',
  };

  it('canonicalizes full assignment state independent of database row order', () => {
    expect(canonicalizeAssignmentSnapshot(snapshot)).toBe(
      canonicalizeAssignmentSnapshot([...snapshot].reverse()),
    );
    expect(hashAssignmentSnapshot(snapshot)).toMatch(/^[a-f\d]{64}$/);
  });

  it.each([
    ['status', { status: 'REVOKED' }],
    ['grantor', { grantedBy: '507f1f77bcf86cd799439014' }],
    ['expiry', { expiresAt: new Date('2026-11-01T00:00:00.000Z') }],
    [
      'provenance',
      { provenanceOperationId: '00000000-0000-4000-8000-000000000002' },
    ],
  ])('changes the snapshot hash when %s changes', (_field, change) => {
    expect(hashAssignmentSnapshot([{ ...snapshot[0], ...change }])).not.toBe(
      hashAssignmentSnapshot(snapshot),
    );
  });

  it('binds the payload hash to the bundle version and pre-state hash', () => {
    const canonical = canonicalizePayload(payload);
    expect(
      canonicalizePayload({
        ...payload,
        expectedCurrentSnapshotHash: 'a'.repeat(64),
      }),
    ).not.toBe(canonical);
    expect(canonicalizePayload({ ...payload, bundleVersion: 'V1' })).not.toBe(
      canonical,
    );
  });
});
