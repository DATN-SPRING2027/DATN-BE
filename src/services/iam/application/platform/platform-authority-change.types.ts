import { createHash } from 'node:crypto';
import type { PlatformPermission } from '../authorization/authorization.policy';

export type PlatformAuthorityOperationType = 'GRANT' | 'REVOKE';

export interface PlatformAuthorityChangePayload {
  operationType: PlatformAuthorityOperationType;
  targetUserId: string;
  permission: PlatformPermission;
  scope: 'PLATFORM';
  actorUserId: string; // Executor principal
  issuerUserId: string; // Authorizing issuer principal
  expectedCurrentStatus?: 'ABSENT' | 'ACTIVE' | 'REVOKED'; // CAS check
  expiresAt?: string | null;
  reasonCode: string;
}

export interface PlatformAuthorityChangeCommand extends PlatformAuthorityChangePayload {
  operationId: string;
  now?: Date;
}

export interface PlatformAuthorityChangeResultBody {
  operationId: string;
  assignmentId: string;
  targetUserId: string;
  permission: PlatformPermission;
  scope: 'PLATFORM';
  status: 'ACTIVE' | 'REVOKED';
  grantedBy?: string;
  grantedAt?: string;
  revokedBy?: string;
  revokedAt?: string;
  expiresAt?: string | null;
}

export interface PlatformAuthorityChangeResult {
  operationId: string;
  status: 'COMMITTED';
  httpStatus: 200 | 201;
  replayed: boolean;
  body: PlatformAuthorityChangeResultBody;
}

export function canonicalizePayload(
  payload: PlatformAuthorityChangePayload,
): string {
  const normalized = {
    actorUserId: payload.actorUserId.toLowerCase(),
    // Keep existing default-false idempotency hashes stable. The command no
    // longer accepts a caller-controlled break-glass override.
    breakGlass: false,
    expectedCurrentStatus: payload.expectedCurrentStatus ?? null,
    expiresAt: payload.expiresAt ?? null,
    issuerUserId: payload.issuerUserId.toLowerCase(),
    operationType: payload.operationType,
    permission: payload.permission,
    reasonCode: payload.reasonCode.trim(),
    scope: payload.scope,
    targetUserId: payload.targetUserId.toLowerCase(),
  };
  return JSON.stringify(normalized, Object.keys(normalized).sort());
}

export function hashPayload(payload: PlatformAuthorityChangePayload): string {
  return createHash('sha256')
    .update(canonicalizePayload(payload))
    .digest('hex');
}
