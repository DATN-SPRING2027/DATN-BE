import { createHash } from 'node:crypto';
import {
  PLATFORM_A04_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PLATFORM_V1_PERMISSIONS,
  type PlatformPermission,
} from '../authorization/authorization.policy';

export const PLATFORM_AUTHORITY_REASON_CODES = {
  BOOTSTRAP: 'PO_AUTH_01_BOOTSTRAP',
  V1_EXPAND: 'PO_AUTH_01_V1_EXPAND',
  V2_EXPAND: 'PO_AUTH_01_V2_EXPAND',
  REGRANT: 'PO_AUTH_01_REGRANT',
  REVOKE: 'PO_AUTH_01_REVOKE',
} as const;

export type PlatformAuthorityOperationType =
  keyof typeof PLATFORM_AUTHORITY_REASON_CODES;
export type PlatformAuthorityBundleVersion = 'A04' | 'V1' | 'V2';

export const PLATFORM_AUTHORITY_BUNDLES: Record<
  PlatformAuthorityBundleVersion,
  readonly PlatformPermission[]
> = {
  A04: PLATFORM_A04_PERMISSIONS,
  V1: PLATFORM_V1_PERMISSIONS,
  V2: PLATFORM_PERMISSIONS,
};

export interface PlatformAuthorityChangePayload {
  operationType: PlatformAuthorityOperationType;
  bundleVersion: PlatformAuthorityBundleVersion;
  targetUserId: string;
  scope: 'PLATFORM';
  actorUserId: string;
  issuerUserId: string;
  expectedCurrentSnapshotHash: string;
  expiresAt?: string | null;
  reasonCode: string;
}

export interface PlatformAuthorityChangeCommand extends PlatformAuthorityChangePayload {
  operationId: string;
  now?: Date;
}

export interface PlatformAuthoritySnapshotRow {
  assignmentId: string;
  permission: string;
  scope: string;
  status: string;
  grantedAt: Date | string | null;
  grantedBy: string;
  expiresAt?: Date | string | null;
  revokedAt?: Date | string | null;
  revokedBy?: string | null;
  provenanceOperationId?: string | null;
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

function normalizeDate(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'INVALID_DATE';
}

export function canonicalizeAssignmentSnapshot(
  assignments: readonly PlatformAuthoritySnapshotRow[],
): string {
  const canonical = assignments
    .map((assignment) => ({
      assignmentId: assignment.assignmentId.toLowerCase(),
      permission: assignment.permission,
      scope: assignment.scope,
      status: assignment.status,
      grantedAt: normalizeDate(assignment.grantedAt),
      grantedBy: assignment.grantedBy.toLowerCase(),
      expiresAt: normalizeDate(assignment.expiresAt),
      revokedAt: normalizeDate(assignment.revokedAt),
      revokedBy: assignment.revokedBy?.toLowerCase() ?? null,
      provenanceOperationId:
        assignment.provenanceOperationId?.toLowerCase() ?? null,
    }))
    .sort(
      (left, right) =>
        left.permission.localeCompare(right.permission) ||
        left.assignmentId.localeCompare(right.assignmentId),
    );
  return JSON.stringify(canonical);
}

export function hashAssignmentSnapshot(
  assignments: readonly PlatformAuthoritySnapshotRow[],
): string {
  return createHash('sha256')
    .update(canonicalizeAssignmentSnapshot(assignments))
    .digest('hex');
}

export function canonicalizePayload(
  payload: PlatformAuthorityChangePayload,
): string {
  return JSON.stringify({
    actorUserId: payload.actorUserId.toLowerCase(),
    bundleVersion: payload.bundleVersion,
    expectedCurrentSnapshotHash:
      payload.expectedCurrentSnapshotHash.toLowerCase(),
    expiresAt: payload.expiresAt ?? null,
    issuerUserId: payload.issuerUserId.toLowerCase(),
    operationType: payload.operationType,
    permissions: [...PLATFORM_AUTHORITY_BUNDLES[payload.bundleVersion]],
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
