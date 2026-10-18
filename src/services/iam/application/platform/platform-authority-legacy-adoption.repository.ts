import type { PlatformAuthorityChangeResult } from './platform-authority-change.types';

export const PLATFORM_AUTHORITY_LEGACY_ADOPTION_REPOSITORY = Symbol(
  'PLATFORM_AUTHORITY_LEGACY_ADOPTION_REPOSITORY',
);

export interface PlatformAuthorityLegacyAdoptionCommand {
  operationId: string;
  actorUserId: string;
  issuerUserId: string;
  expectedCurrentSnapshotHash: string;
  now?: Date;
}

export interface PlatformAuthorityLegacyAdoptionPreflight {
  targetEmail: 'operator@continuum.test';
  targetUserId: string | null;
  targetStatus: string | null;
  actorUserId: string | null;
  actorStatus: string | null;
  issuerUserId: string | null;
  issuerStatus: string | null;
  assignmentCount: number;
  expectedCurrentSnapshotHash: string | null;
  ready: boolean;
  blockers: readonly string[];
}

export interface PlatformAuthorityLegacyAdoptionRepository {
  inspect(): Promise<PlatformAuthorityLegacyAdoptionPreflight>;
  adopt(
    command: PlatformAuthorityLegacyAdoptionCommand,
  ): Promise<PlatformAuthorityChangeResult>;
}
