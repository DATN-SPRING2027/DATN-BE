export const AUTHENTICATION_REPOSITORY = Symbol('AUTHENTICATION_REPOSITORY');

export interface AuthenticationAccount {
  userId: string;
  email: string;
  name: string;
  passwordHash: string;
  status: string;
  twoFactorEnabled: boolean;
}

export interface OrganizationRoleAssignment {
  organizationId: string;
  roleCode: string;
}

export interface LoginOrganizationOption {
  id: string;
  name: string;
}

export interface AuthenticationProfile {
  name: string;
  status: string;
}

export interface RefreshAccount {
  email: string;
  status: string;
  twoFactorEnabled: boolean;
}

export type RefreshSessionContext = 'ORGANIZATION' | 'PLATFORM';

export type NewRefreshSession =
  | {
      userId: string;
      context: 'ORGANIZATION';
      organizationId: string;
      tokenHash: string;
      expiresAt: Date;
    }
  | {
      userId: string;
      context: 'PLATFORM';
      tokenHash: string;
      expiresAt: Date;
    };

export type RefreshRotationResult =
  | {
      outcome: 'ROTATED';
      userId: string;
      context: 'ORGANIZATION';
      organizationId: string;
    }
  | {
      outcome: 'ROTATED';
      userId: string;
      context: 'PLATFORM';
    }
  | { outcome: 'REPLAYED' | 'INVALID' };

export type RefreshSessionLookup =
  | {
      outcome: 'ACTIVE' | 'REVOKED';
      userId: string;
      context: 'ORGANIZATION';
      organizationId: string;
      expiresAt: Date;
    }
  | {
      outcome: 'ACTIVE' | 'REVOKED';
      userId: string;
      context: 'PLATFORM';
      expiresAt: Date;
    }
  | { outcome: 'INVALID' };

export interface AuthenticationRepositoryPort {
  findAccountByEmail(email: string): Promise<AuthenticationAccount | null>;
  findActiveOrganizationMembershipIds(userId: string): Promise<string[]>;
  findOrganizationRoleAssignments(
    userId: string,
  ): Promise<OrganizationRoleAssignment[]>;
  findOrganizationOptions(ids: string[]): Promise<LoginOrganizationOption[]>;
  findProfileById(userId: string): Promise<AuthenticationProfile | null>;
  replacePasswordHashIfCurrent(
    userId: string,
    currentHash: string,
    replacementHash: string,
  ): Promise<void>;
  revokeRefreshSessionByHash(tokenHash: string): Promise<boolean>;
  findRefreshSessionForRotation(
    tokenHash: string,
  ): Promise<RefreshSessionLookup>;
  rotateRefreshSession(
    currentHash: string,
    replacementHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<RefreshRotationResult>;
  findAccountById(userId: string): Promise<RefreshAccount | null>;
  createRefreshSession(session: NewRefreshSession): Promise<void>;
}
