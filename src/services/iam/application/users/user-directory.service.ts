import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import {
  USER_DIRECTORY_REPOSITORY,
  type UserDirectoryRepository,
  type UserListQuery,
  type UserRecord,
  type UserUpdate,
} from './user-directory.repository';

@Injectable()
export class UserDirectoryService {
  constructor(
    @Inject(USER_DIRECTORY_REPOSITORY)
    private readonly repository: UserDirectoryRepository,
  ) {}

  async list(actor: AuthenticatedIdentity, query: UserListQuery) {
    await this.requireAdmin(actor);
    const result = await this.repository.list(actor.organizationId, query);
    return {
      data: result.data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / query.pageSize),
      },
    };
  }

  async get(actor: AuthenticatedIdentity, userId: string): Promise<UserRecord> {
    if (actor.id !== userId) await this.requireAdmin(actor);
    const user = await this.repository.find(actor.organizationId, userId);
    if (!user)
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });
    return user;
  }

  async update(
    actor: AuthenticatedIdentity,
    userId: string,
    changes: UserUpdate,
  ): Promise<UserRecord> {
    const isSelf = actor.id === userId;
    if (!isSelf) await this.requireAdmin(actor);
    if (changes.status !== undefined) {
      if (isSelf)
        throw new ForbiddenException({
          code: 'SELF_STATUS_CHANGE_FORBIDDEN',
          message: 'Cannot change your own status.',
        });
      await this.requireAdmin(actor);
    }
    const existing = await this.repository.find(actor.organizationId, userId);
    if (!existing)
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });

    if (
      existing.status === 'ACTIVE' &&
      changes.status !== undefined &&
      changes.status !== 'ACTIVE' &&
      existing.roleCodes.includes('ADMIN')
    ) {
      if (
        (await this.repository.countActiveAdmins(actor.organizationId)) <= 1
      ) {
        throw new ConflictException({
          code: 'LAST_ACTIVE_ADMIN',
          message: 'The last active organization admin cannot be suspended.',
        });
      }
    }

    const updated = await this.repository.update(
      actor.organizationId,
      userId,
      changes,
    );
    if (!updated)
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });
    return updated;
  }

  private async requireAdmin(actor: AuthenticatedIdentity): Promise<void> {
    if (!(await this.repository.isAdmin(actor.organizationId, actor.id))) {
      throw new ForbiddenException({
        code: 'USER_MANAGEMENT_FORBIDDEN',
        message: 'Organization admin access required.',
      });
    }
  }
}
