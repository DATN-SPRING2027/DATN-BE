import { createHash } from 'node:crypto';
import {
  PLATFORM_PERMISSIONS,
  type PlatformPermission,
} from '../authorization/authorization.policy';

export const PLATFORM_AUTHORITY_REASON_CODES = {
  BOOTSTRAP: 'PO_AUTH_01_BOOTSTRAP',
  REGRANT: 'PO_AUTH_01_REGRANT',
  REVOKE: 'PO_AUTH_01_REVOKE',
} as const;

export type PlatformAuthorityOperationType =
  keyof typeof PLATFORM_AUTHORITY_REASON_CODES;

export interface PlatformAuthorityChangePayload {
  operationType: PlatformAuthorityOperationType;
  targetUserId: string;
  scope: 'PLATFORM';
  actorUserId: string;
  issuerUserId: string;
  expectedCurrentStatus?: 'ABSENT' | 'ACTIVE' | 'REVOKED';
  expiresAt?: string | null;
  reasonCode: string;
}

export interface PlatformAuthorityChangeCommand extends PlatformAuthorityChangePayload {
  operationId: string;
  now?: Date;
}

export interface PlatformAuthorityAssignmentResult {
  assignmentId: string;
  permission: PlatformPermission;
  status: 'ACTIVE' | 'REVOKED';
  grantedBy?: string;
  grantedAt?: string;
  revokedBy?: string;
  revokedAt?: string;
  expiresAt?: string | null;
}

export interface PlatformAuthorityChangeResultBody {
  operationId: string;
  targetUserId: string;
  scope: 'PLATFORM';
  status: 'ACTIVE' | 'REVOKED';
  assignments: PlatformAuthorityAssignmentResult[];
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
  return JSON.stringify({
    actorUserId: payload.actorUserId.toLowerCase(),
    expectedCurrentStatus: payload.expectedCurrentStatus ?? null,
    expiresAt: payload.expiresAt ?? null,
    issuerUserId: payload.issuerUserId.toLowerCase(),
    operationType: payload.operationType,
    permissions: [...PLATFORM_PERMISSIONS],
    reasonCode: payload.reasonCode,
    scope: payload.scope,
    targetUserId: payload.targetUserId.toLowerCase(),
  });
}

export function hashPayload(payload: PlatformAuthorityChangePayload): string {
  return createHash('sha256')
    .update(canonicalizePayload(payload))
    .digest('hex');
}
