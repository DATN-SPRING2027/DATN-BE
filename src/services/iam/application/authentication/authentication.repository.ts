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

export type RefreshRotationResult =
  | { outcome: 'ROTATED'; userId: string; organizationId: string }
  | { outcome: 'REPLAYED' | 'INVALID' };

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
  rotateRefreshSession(
    currentHash: string,
    replacementHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<RefreshRotationResult>;
  findAccountById(userId: string): Promise<RefreshAccount | null>;
}
