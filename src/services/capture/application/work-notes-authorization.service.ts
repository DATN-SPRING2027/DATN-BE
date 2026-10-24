import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CaptureRequestHeaders, WorkNotesActor } from './work-notes.types';

const validId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

interface IdentityResponse {
  id?: string;
  name?: string;
  organizationId?: string;
}

interface MembershipResponse {
  data?: Array<{
    userId?: string;
    user?: { fullName?: string; email?: string } | null;
  }>;
  pagination?: { totalPages?: number };
}

@Injectable()
export class WorkNotesAuthorizationService {
  constructor(private readonly config: ConfigService) {}

  async resolveProject(
    headers: CaptureRequestHeaders,
    projectId: string,
  ): Promise<WorkNotesActor> {
    if (!validId(projectId)) {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }
    const normalizedProjectId = projectId.toLowerCase();

    const identity = await this.request<IdentityResponse>(
      '/api/v1/auth/me',
      headers,
    );
    const userId = identity?.id;
    const organizationId = identity?.organizationId;
    if (
      !identity ||
      !userId ||
      !validId(userId) ||
      !organizationId ||
      !validId(organizationId)
    ) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'An active organization session is required.',
      });
    }
    if (
      headers.organizationId !== undefined &&
      headers.organizationId !== organizationId
    ) {
      throw this.projectNotFound();
    }

    const project = await this.request<Record<string, unknown>>(
      `/api/v1/iam/projects/${normalizedProjectId}`,
      headers,
    );
    if (
      !project ||
      String(project.id).toLowerCase() !== normalizedProjectId ||
      project.organizationId !== organizationId
    ) {
      throw this.projectNotFound();
    }

    const settingsAccess = await this.request<{ canUpdateProject?: boolean }>(
      `/api/v1/iam/projects/${normalizedProjectId}/settings-access`,
      headers,
      { allowForbidden: true },
    );
    const canReview = settingsAccess?.canUpdateProject === true;

    return {
      userId,
      userName: typeof identity.name === 'string' ? identity.name : '',
      organizationId,
      projectId: normalizedProjectId,
      canReview,
      canConfigure: canReview,
    };
  }

  async resolveTask(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
  ): Promise<WorkNotesActor> {
    const actor = await this.resolveProject(headers, projectId);
    if (!validId(taskId)) {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: 'Task not found.',
      });
    }

    const normalizedTaskId = taskId.toLowerCase();
    const task = await this.request<Record<string, unknown>>(
      `/api/v1/tasks/projects/${actor.projectId}/tasks/${normalizedTaskId}`,
      headers,
    );
    if (
      !task ||
      String(task.id).toLowerCase() !== normalizedTaskId ||
      String(task.projectId).toLowerCase() !== actor.projectId
    ) {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: 'Task not found.',
      });
    }
    return actor;
  }

  async listActiveMembers(
    actor: WorkNotesActor,
    headers: CaptureRequestHeaders,
  ): Promise<Array<{ userId: string; fullName: string }>> {
    if (!actor.canReview) {
      throw new ForbiddenException({
        code: 'PROJECT_REVIEW_PERMISSION_REQUIRED',
        message: 'Project review permission is required.',
      });
    }

    const members = new Map<string, string>();
    let page = 1;
    let totalPages = 1;
    do {
      const result = await this.request<MembershipResponse>(
        `/api/v1/iam/projects/${actor.projectId}/memberships?page=${page}&pageSize=100&status=ACTIVE`,
        headers,
      );
      if (!Array.isArray(result?.data)) {
        throw this.membersUnavailable();
      }
      for (const membership of result.data) {
        if (validId(membership.userId ?? '')) {
          const userId = membership.userId!.toLowerCase();
          members.set(
            userId,
            membership.user?.fullName?.trim() ||
              membership.user?.email?.trim() ||
              userId,
          );
        }
      }
      totalPages = result.pagination?.totalPages ?? 1;
      if (
        !Number.isSafeInteger(totalPages) ||
        totalPages < 1 ||
        totalPages > 1000
      ) {
        throw this.membersUnavailable();
      }
      page += 1;
    } while (page <= totalPages);

    const leadersResponse = await this.request<{
      data?: Array<{ userId?: string }>;
    }>(`/api/v1/iam/projects/${actor.projectId}/leaders`, headers);
    if (!Array.isArray(leadersResponse?.data)) {
      throw this.membersUnavailable();
    }
    const leaderIds = new Set(
      leadersResponse.data
        .map((leader) => leader.userId)
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.toLowerCase()),
    );

    return [...members.entries()]
      .filter(([userId]) => !leaderIds.has(userId))
      .map(([userId, fullName]) => ({ userId, fullName }));
  }

  private async request<T>(
    path: string,
    incoming: CaptureRequestHeaders,
    options: { allowForbidden?: boolean } = {},
  ): Promise<T | null> {
    const baseUrl = this.config.getOrThrow<string>('IAM_SERVICE_URL');
    const headers = new Headers({ accept: 'application/json' });
    if (incoming.authorization)
      headers.set('authorization', incoming.authorization);
    if (incoming.cookie) headers.set('cookie', incoming.cookie);
    if (incoming.organizationId)
      headers.set('x-organization-id', incoming.organizationId);
    if (incoming.requestId) headers.set('x-request-id', incoming.requestId);

    let response: Response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(
          this.config.get<number>('BACKEND_TIMEOUT_MS') ?? 10_000,
        ),
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'IDENTITY_SERVICE_UNAVAILABLE',
        message: 'Project authorization is temporarily unavailable.',
      });
    }

    if (response.status === 401) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'An active organization session is required.',
      });
    }
    if (response.status === 403 && options.allowForbidden) return null;
    if (response.status === 403) {
      throw new ForbiddenException({
        code: 'PROJECT_ACCESS_DENIED',
        message: 'Project access is required.',
      });
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ServiceUnavailableException({
        code: 'IDENTITY_SERVICE_UNAVAILABLE',
        message: 'Project authorization is temporarily unavailable.',
      });
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ServiceUnavailableException({
        code: 'IDENTITY_SERVICE_UNAVAILABLE',
        message: 'Project authorization returned an invalid response.',
      });
    }
  }

  private projectNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found.',
    });
  }

  private membersUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'PROJECT_MEMBERS_UNAVAILABLE',
      message: 'Active Project Members are temporarily unavailable.',
    });
  }
}
