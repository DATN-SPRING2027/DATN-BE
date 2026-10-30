import { createHash } from 'node:crypto';
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
const PROJECT_AUTH_CACHE_TTL_MS = 3_000;
const PROJECT_AUTH_CACHE_MAX_ENTRIES = 512;

interface IdentityResponse {
  id?: string;
  name?: string;
  organizationId?: string;
  roles?: string[];
}

interface MembershipResponse {
  data?: Array<{
    userId?: string;
    joinedAt?: string;
    user?: { fullName?: string; email?: string } | null;
  }>;
  pagination?: { totalPages?: number };
}

@Injectable()
export class WorkNotesAuthorizationService {
  private readonly projectActorCache = new Map<
    string,
    { actor: WorkNotesActor; expiresAt: number }
  >();

  private readonly inFlightProjectResolutions = new Map<
    string,
    Promise<WorkNotesActor>
  >();

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
    const cacheKey = this.buildProjectCacheKey(headers, normalizedProjectId);
    if (cacheKey === null) {
      return this.resolveProjectUncached(headers, normalizedProjectId);
    }

    const now = Date.now();
    const cached = this.projectActorCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > now) {
        return { ...cached.actor };
      }
      this.projectActorCache.delete(cacheKey);
    }

    const existingInFlight = this.inFlightProjectResolutions.get(cacheKey);
    if (existingInFlight) {
      const sharedActor = await existingInFlight;
      return { ...sharedActor };
    }

    const resolutionPromise = this.resolveProjectUncached(
      headers,
      normalizedProjectId,
    );
    this.inFlightProjectResolutions.set(cacheKey, resolutionPromise);
    try {
      const actor = await resolutionPromise;
      this.storeCachedProjectActor(cacheKey, actor);
      return { ...actor };
    } finally {
      this.inFlightProjectResolutions.delete(cacheKey);
    }
  }

  private buildProjectCacheKey(
    headers: CaptureRequestHeaders,
    normalizedProjectId: string,
  ): string | null {
    const auth = headers.authorization?.trim() ?? '';
    const cookie = headers.cookie?.trim() ?? '';
    if (!auth && !cookie) {
      return null;
    }
    const credentialDigest = createHash('sha256')
      .update(`${auth}\0${cookie}`)
      .digest('hex');
    return `${credentialDigest}:${headers.organizationId ?? ''}:${normalizedProjectId}`;
  }

  private storeCachedProjectActor(
    cacheKey: string,
    actor: WorkNotesActor,
  ): void {
    const now = Date.now();
    if (this.projectActorCache.size >= PROJECT_AUTH_CACHE_MAX_ENTRIES) {
      for (const [key, entry] of this.projectActorCache) {
        if (entry.expiresAt <= now) {
          this.projectActorCache.delete(key);
        }
      }
      if (this.projectActorCache.size >= PROJECT_AUTH_CACHE_MAX_ENTRIES) {
        for (const oldestKey of this.projectActorCache.keys()) {
          this.projectActorCache.delete(oldestKey);
          break;
        }
      }
    }
    this.projectActorCache.set(cacheKey, {
      actor: { ...actor },
      expiresAt: now + PROJECT_AUTH_CACHE_TTL_MS,
    });
  }

  private async resolveProjectUncached(
    headers: CaptureRequestHeaders,
    normalizedProjectId: string,
  ): Promise<WorkNotesActor> {
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
      Array.isArray(identity.roles) &&
      identity.roles.includes('PLATFORM_OPERATOR')
    ) {
      throw new ForbiddenException({
        code: 'PLATFORM_OPERATOR_PROJECT_ACCESS_FORBIDDEN',
        message: 'Platform operators cannot access project Work Reports.',
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
      project.organizationId !== organizationId ||
      (typeof project.status === 'string' && project.status !== 'ACTIVE')
    ) {
      throw this.projectNotFound();
    }

    const isManager =
      Array.isArray(identity.roles) && identity.roles.includes('ADMIN');
    const settingsAccess = await this.request<{ canUpdateProject?: boolean }>(
      `/api/v1/iam/projects/${normalizedProjectId}/settings-access`,
      headers,
      { allowForbidden: true },
    );
    const isLeader = settingsAccess?.canUpdateProject === true;
    const canReview = isLeader || isManager;
    const joinedAt = canReview
      ? typeof project.createdAt === 'string' &&
        Number.isFinite(Date.parse(project.createdAt))
        ? project.createdAt
        : undefined
      : await this.resolveActiveMemberJoinedAt(
          normalizedProjectId,
          userId.toLowerCase(),
          headers,
        );

    return {
      userId,
      userName: typeof identity.name === 'string' ? identity.name : '',
      organizationId,
      projectId: normalizedProjectId,
      canReview,
      canConfigure: canReview,
      isManager,
      isLeader,
      ...(joinedAt ? { joinedAt } : {}),
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
    const taskServiceConfigured = Boolean(
      this.config.get<string>('TASK_SERVICE_URL'),
    );
    const task = await this.request<Record<string, unknown>>(
      `${taskServiceConfigured ? '' : '/api/v1'}/internal/tasks/projects/${actor.projectId}/tasks/${normalizedTaskId}`,
      headers,
      { service: 'task' },
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
    const taskKey =
      typeof task.key === 'string' && task.key.trim().length > 0
        ? task.key.trim()
        : undefined;
    const taskTitle =
      typeof task.title === 'string' && task.title.trim().length > 0
        ? task.title.trim()
        : undefined;
    const validTaskVersion =
      typeof task.version === 'number' &&
      Number.isSafeInteger(task.version) &&
      task.version >= 1;
    return {
      ...actor,
      taskContextInvalid:
        !taskTitle ||
        (task.description !== undefined &&
          task.description !== null &&
          typeof task.description !== 'string') ||
        typeof task.status !== 'string' ||
        task.status.trim().length === 0 ||
        (task.version !== undefined && !validTaskVersion) ||
        (task.steps !== undefined &&
          (!Array.isArray(task.steps) ||
            task.steps.some(
              (step: unknown) =>
                !step ||
                typeof step !== 'object' ||
                typeof (step as Record<string, unknown>).text !== 'string' ||
                typeof (step as Record<string, unknown>).done !== 'boolean',
            ))),
      ...(validTaskVersion ? { taskContextVersion: String(task.version) } : {}),
      ...(taskKey ? { taskKey } : {}),
      ...(taskTitle ? { taskTitle } : {}),
      ...(taskTitle
        ? {
            taskContext: {
              title: taskTitle,
              description:
                typeof task.description === 'string' ? task.description : null,
              status: typeof task.status === 'string' ? task.status : '',
              steps: Array.isArray(task.steps)
                ? task.steps
                    .filter(
                      (
                        step: unknown,
                      ): step is { text: string; done: boolean } =>
                        !!step &&
                        typeof step === 'object' &&
                        typeof (step as Record<string, unknown>).text ===
                          'string' &&
                        typeof (step as Record<string, unknown>).done ===
                          'boolean',
                    )
                    .map((step: { text: string; done: boolean }) => ({
                      text: step.text,
                      done: step.done,
                    }))
                : [],
            },
          }
        : {}),
    };
  }

  async listActiveMembers(
    actor: WorkNotesActor,
    headers: CaptureRequestHeaders,
  ): Promise<Array<{ userId: string; fullName: string; joinedAt: string }>> {
    if (!actor.canReview) {
      throw new ForbiddenException({
        code: 'PROJECT_REVIEW_PERMISSION_REQUIRED',
        message: 'Project review permission is required.',
      });
    }

    const fallbackJoinedAt =
      actor.joinedAt && Number.isFinite(Date.parse(actor.joinedAt))
        ? actor.joinedAt
        : new Date().toISOString();

    const members = new Map<string, { fullName: string; joinedAt: string }>();
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
          const resolvedJoinedAt =
            membership.joinedAt &&
            Number.isFinite(Date.parse(membership.joinedAt))
              ? membership.joinedAt
              : fallbackJoinedAt;
          members.set(userId, {
            fullName:
              membership.user?.fullName?.trim() ||
              membership.user?.email?.trim() ||
              userId,
            joinedAt: resolvedJoinedAt,
          });
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
      data?: Array<{ userId?: string; status?: string }>;
    }>(`/api/v1/iam/projects/${actor.projectId}/leaders`, headers);
    if (!Array.isArray(leadersResponse?.data)) {
      throw this.membersUnavailable();
    }
    const leaderIds = new Set(
      leadersResponse.data
        .filter(
          (leader) => leader.status === undefined || leader.status === 'ACTIVE',
        )
        .map((leader) => leader.userId)
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.toLowerCase()),
    );

    return [...members.entries()]
      .filter(([userId]) => !leaderIds.has(userId))
      .map(([userId, membership]) => ({ userId, ...membership }));
  }

  async listActiveLeaders(
    actor: WorkNotesActor,
    headers: CaptureRequestHeaders,
  ): Promise<Array<{ userId: string; fullName: string; joinedAt: string }>> {
    if (!actor.canReview) {
      throw new ForbiddenException({
        code: 'PROJECT_REVIEW_PERMISSION_REQUIRED',
        message: 'Project review permission is required.',
      });
    }

    const fallbackJoinedAt =
      actor.joinedAt && Number.isFinite(Date.parse(actor.joinedAt))
        ? actor.joinedAt
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const members = new Map<string, { fullName: string; joinedAt: string }>();
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
          const resolvedJoinedAt =
            membership.joinedAt &&
            Number.isFinite(Date.parse(membership.joinedAt))
              ? membership.joinedAt
              : fallbackJoinedAt;
          members.set(userId, {
            fullName:
              membership.user?.fullName?.trim() ||
              membership.user?.email?.trim() ||
              userId,
            joinedAt: resolvedJoinedAt,
          });
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
      data?: Array<{
        userId?: string;
        fullName?: string;
        email?: string;
        status?: string;
      }>;
    }>(`/api/v1/iam/projects/${actor.projectId}/leaders`, headers);
    if (!Array.isArray(leadersResponse?.data)) {
      throw this.membersUnavailable();
    }

    const activeLeaders: Array<{
      userId: string;
      fullName: string;
      joinedAt: string;
    }> = [];
    for (const leader of leadersResponse.data) {
      if (leader.status !== undefined && leader.status !== 'ACTIVE') continue;
      if (typeof leader.userId !== 'string' || !validId(leader.userId))
        continue;
      const userId = leader.userId.toLowerCase();
      const memberEntry = members.get(userId);
      activeLeaders.push({
        userId,
        fullName:
          leader.fullName?.trim() ||
          memberEntry?.fullName ||
          leader.email?.trim() ||
          userId,
        joinedAt: memberEntry?.joinedAt ?? fallbackJoinedAt,
      });
    }
    return activeLeaders;
  }

  private async resolveActiveMemberJoinedAt(
    projectId: string,
    normalizedUserId: string,
    headers: CaptureRequestHeaders,
  ): Promise<string> {
    let page = 1;
    let totalPages = 1;
    do {
      const result = await this.request<MembershipResponse>(
        `/api/v1/iam/projects/${projectId}/memberships?page=${page}&pageSize=100&status=ACTIVE`,
        headers,
        { allowForbidden: true },
      );
      if (result === null) {
        throw this.projectNotFound();
      }
      if (!Array.isArray(result?.data)) {
        throw this.membersUnavailable();
      }
      for (const membership of result.data) {
        if (
          typeof membership.userId === 'string' &&
          membership.userId.toLowerCase() === normalizedUserId
        ) {
          if (
            !membership.joinedAt ||
            !Number.isFinite(Date.parse(membership.joinedAt))
          ) {
            throw this.membersUnavailable();
          }
          return membership.joinedAt;
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

    throw this.projectNotFound();
  }

  private async request<T>(
    path: string,
    incoming: CaptureRequestHeaders,
    options: { allowForbidden?: boolean; service?: 'iam' | 'task' } = {},
  ): Promise<T | null> {
    const baseUrl =
      options.service === 'task'
        ? (this.config.get<string>('TASK_SERVICE_URL') ??
          this.config.getOrThrow<string>('IAM_SERVICE_URL'))
        : this.config.getOrThrow<string>('IAM_SERVICE_URL');
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
