export const USER_DIRECTORY_REPOSITORY = Symbol('USER_DIRECTORY_REPOSITORY');

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_INVITE';
export type RoleCode = 'ADMIN' | 'TEAM_LEADER' | 'MEMBER';

export interface UserRecord {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  status: UserStatus;
  roleCodes: string[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserListQuery {
  page: number;
  pageSize: number;
  status?: UserStatus;
  roleCode?: RoleCode;
}

export interface UserUpdate {
  fullName?: string;
  avatarUrl?: string | null;
  status?: UserStatus;
}

export interface UserDirectoryRepository {
  isAdmin(organizationId: string, actorId: string): Promise<boolean>;
  list(
    organizationId: string,
    query: UserListQuery,
  ): Promise<{ data: UserRecord[]; totalItems: number }>;
  find(organizationId: string, userId: string): Promise<UserRecord | null>;
  update(
    organizationId: string,
    userId: string,
    changes: UserUpdate,
  ): Promise<UserRecord | null>;
  countActiveAdmins(organizationId: string): Promise<number>;
}
