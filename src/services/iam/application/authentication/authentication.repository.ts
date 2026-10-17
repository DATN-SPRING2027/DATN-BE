export const AUTHENTICATION_REPOSITORY = Symbol('AUTHENTICATION_REPOSITORY');

export interface AuthenticationAccount {
  userId: string;
  email: string;
  name: string;
  passwordHash: string;
  googleSubject?: string;
  status: string;
  twoFactorEnabled: boolean;
}

export interface NewGoogleAccount {
  email: string;
  name: string;
  googleSubject: string;
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
  mutationFence?: number;
}

export interface RefreshAccount {
  email: string;
  status: string;
  twoFactorEnabled: boolean;
}

export type RefreshSessionContext = 'ORGANIZATION' | 'PLATFORM' | 'ACCOUNT';

export type NewRefreshSession =
  | {
      userId: string;
      context: 'ACCOUNT';
      sessionId: string;
      userFence: number;
      tokenHash: string;
      expiresAt: Date;
    }
  | {
      userId: string;
      context: 'ORGANIZATION';
      organizationId: string;
      sessionId: string;
      userFence: number;
      tokenHash: string;
      expiresAt: Date;
    }
  | {
      userId: string;
      context: 'PLATFORM';
      sessionId: string;
      userFence: number;
      tokenHash: string;
      expiresAt: Date;
    };

export type RefreshRotationResult =
  | {
      outcome: 'ROTATED';
      userId: string;
      context: 'ACCOUNT';
    }
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
      sessionId: string;
      userFence: number;
      context: 'ACCOUNT';
      expiresAt: Date;
    }
  | {
      outcome: 'ACTIVE' | 'REVOKED';
      userId: string;
      sessionId: string;
      userFence: number;
      context: 'ORGANIZATION';
      organizationId: string;
      expiresAt: Date;
    }
  | {
      outcome: 'ACTIVE' | 'REVOKED';
      userId: string;
      sessionId: string;
      userFence: number;
      context: 'PLATFORM';
      expiresAt: Date;
    }
  | { outcome: 'INVALID' };

export interface AuthenticationRepositoryPort {
  findAccountByEmail(email: string): Promise<AuthenticationAccount | null>;
  findAccountByGoogleSubject(
    googleSubject: string,
  ): Promise<AuthenticationAccount | null>;
  linkGoogleSubjectIfMissing(
    userId: string,
    googleSubject: string,
  ): Promise<boolean>;
  createGoogleAccount(input: NewGoogleAccount): Promise<AuthenticationAccount>;
  findActiveOrganizationMembershipIds(
    this: void,
    userId: string,
  ): Promise<string[]>;
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
  resetPassword(
    this: void,
    userId: string,
    replacementHash: string,
  ): Promise<boolean>;
  revokeRefreshSessionByHash(tokenHash: string): Promise<boolean>;
  findRefreshSessionForRotation(
    tokenHash: string,
  ): Promise<RefreshSessionLookup>;
  rotateRefreshSession(
    currentHash: string,
    replacementHash: string,
    expiresAt: Date,
    now: Date,
    sessionId?: string,
  ): Promise<RefreshRotationResult>;
  hasActiveRefreshSession(
    userId: string,
    sessionId: string,
    now: Date,
  ): Promise<boolean>;
  findAccountById(userId: string): Promise<RefreshAccount | null>;
  createRefreshSession(this: void, session: NewRefreshSession): Promise<void>;
}
