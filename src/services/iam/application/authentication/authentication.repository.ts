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

export interface AuthenticationProfile {
  name: string;
  status: string;
}

export interface AuthenticationRepositoryPort {
  findAccountByEmail(email: string): Promise<AuthenticationAccount | null>;
  findOrganizationRoleAssignments(
    userId: string,
  ): Promise<OrganizationRoleAssignment[]>;
  findProfileById(userId: string): Promise<AuthenticationProfile | null>;
  replacePasswordHashIfCurrent(
    userId: string,
    currentHash: string,
    replacementHash: string,
  ): Promise<void>;
  revokeRefreshSessionByHash(tokenHash: string): Promise<boolean>;
}
