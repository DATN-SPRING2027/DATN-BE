import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { EXPECTED_ORGANIZATION_ID_HEADER } from '../../../common/http/organization-header';
import { IamActorContextService } from '../../iam/application/projects/iam-actor-context.service';
import { IAM_PERSISTENCE } from '../../iam/infrastructure/persistence';
import { TaskWorkspaceRepository } from '../../task/workspace/task-workspace.repository';
import {
  WORKSPACE_TASKS_COLLECTION,
  type WorkspaceTaskDocument,
} from '../../task/workspace/task-workspace.types';
import type {
  CaptureRequestHeaders,
  RelatedTaskRef,
  WorkNotesActor,
} from './work-notes.types';

const validId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

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
    reactivatedAt?: string;
    user?: { fullName?: string; email?: string } | null;
  }>;
  pagination?: { totalPages?: number };
}

function resolveEffectiveJoinedAt(
  membership: { joinedAt?: string; reactivatedAt?: string },
  fallback?: string,
): string | undefined {
  const joinedMs =
    membership.joinedAt && Number.isFinite(Date.parse(membership.joinedAt))
      ? Date.parse(membership.joinedAt)
      : NaN;
  const reactivatedMs =
    membership.reactivatedAt &&
    Number.isFinite(Date.parse(membership.reactivatedAt))
      ? Date.parse(membership.reactivatedAt)
      : NaN;
  if (Number.isFinite(reactivatedMs) && Number.isFinite(joinedMs)) {
    return reactivatedMs >= joinedMs
      ? membership.reactivatedAt
      : membership.joinedAt;
  }
  if (Number.isFinite(reactivatedMs)) return membership.reactivatedAt;
  if (Number.isFinite(joinedMs)) return membership.joinedAt;
  return fallback;
}

@Injectable()
export class WorkNotesAuthorizationService {
  private readonly inFlightProjectResolutions = new Map<
    string,
    Promise<WorkNotesActor>
  >();
  private resolvedIamActorContext?: IamActorContextService | null;
  private resolvedTaskWorkspaceRepo?: TaskWorkspaceRepository | null;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly iamConnection?: Connection,
    @Optional() iamActorContextOverride?: IamActorContextService,
    @Optional() taskWorkspaceRepoOverride?: TaskWorkspaceRepository,
  ) {
    if (iamActorContextOverride) {
      this.resolvedIamActorContext = iamActorContextOverride;
    }
    if (taskWorkspaceRepoOverride) {
      this.resolvedTaskWorkspaceRepo = taskWorkspaceRepoOverride;
    }
  }

  private getIamActorContext(): IamActorContextService | null {
    if (this.resolvedIamActorContext !== undefined) {
      return this.resolvedIamActorContext;
    }
    if (!this.moduleRef) {
      this.resolvedIamActorContext = null;
      return null;
    }
    try {
      this.resolvedIamActorContext =
        this.moduleRef.get(IamActorContextService, { strict: false }) ?? null;
    } catch {
      this.resolvedIamActorContext = null;
    }
    return this.resolvedIamActorContext;
  }

  private getTaskWorkspaceRepository(): TaskWorkspaceRepository | null {
    if (this.resolvedTaskWorkspaceRepo !== undefined) {
      return this.resolvedTaskWorkspaceRepo;
    }
    if (!this.moduleRef) {
      this.resolvedTaskWorkspaceRepo = null;
      return null;
    }
    try {
      this.resolvedTaskWorkspaceRepo =
        this.moduleRef.get(TaskWorkspaceRepository, { strict: false }) ?? null;
    } catch {
      this.resolvedTaskWorkspaceRepo = null;
    }
    return this.resolvedTaskWorkspaceRepo;
  }

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

    // SEC-AUTH-007: Do NOT cache authorization decisions across sequential
    // requests (eliminates 3s stale-revocation window). Keep in-flight request
    // coalescing for simultaneous bursts only.
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

  private async resolveProjectUncached(
    headers: CaptureRequestHeaders,
    normalizedProjectId: string,
  ): Promise<WorkNotesActor> {
    // BE-PERF-003: Prefer in-process IamActorContextService in monolith mode
    // (1 parallel DB roundtrip, zero loopback HTTP hops, still per-request fresh
    // with no cross-request stale revocation cache per SEC-AUTH-007).
    const iamActorContext = this.getIamActorContext();
    if (iamActorContext) {
      const ctx = await iamActorContext.resolveProjectActorContext({
        authorization: headers.authorization,
        cookie: headers.cookie,
        projectId: normalizedProjectId,
        organizationHeader: headers.organizationId,
        requireActiveProject: true,
      });
      if (
        Array.isArray(ctx.actor.roles) &&
        ctx.actor.roles.includes('PLATFORM_OPERATOR')
      ) {
        throw new ForbiddenException({
          code: 'PLATFORM_OPERATOR_PROJECT_ACCESS_FORBIDDEN',
          message: 'Platform operators cannot access project Work Reports.',
        });
      }
      if (!ctx.isProjectMember && !ctx.isManager) {
        throw this.projectNotFound();
      }
      return {
        userId: ctx.actor.id,
        userName: typeof ctx.actor.name === 'string' ? ctx.actor.name : '',
        organizationId: ctx.actor.organizationId,
        projectId: normalizedProjectId,
        canReview: ctx.canReview,
        canConfigure: ctx.canReview,
        isManager: ctx.isManager,
        isLeader: ctx.isLeader,
        isProjectMember: ctx.isProjectMember,
        ...(ctx.joinedAt ? { joinedAt: ctx.joinedAt } : {}),
      };
    }

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

  private normalizeTaskDoc(
    doc: WorkspaceTaskDocument,
  ): Record<string, unknown> {
    return {
      id: doc._id.toHexString(),
      projectId: doc.projectId.toHexString(),
      organizationId: doc.organizationId.toHexString(),
      key: doc.key,
      title: doc.title,
      description: doc.description ?? null,
      status: doc.status,
      version: doc.version,
      parentId: doc.parentId ? doc.parentId.toHexString() : null,
      steps: doc.steps,
    };
  }

  private mapTaskToActor(
    actor: WorkNotesActor,
    normalizedTaskId: string,
    task: Record<string, unknown>,
  ): WorkNotesActor {
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
      ...(typeof task.parentId === 'string' && validId(task.parentId)
        ? { taskParentId: task.parentId.toLowerCase() }
        : task.parentId === null
          ? { taskParentId: null }
          : {}),
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

  private async resolveTaskForActor(
    headers: CaptureRequestHeaders,
    actor: WorkNotesActor,
    normalizedTaskId: string,
  ): Promise<WorkNotesActor> {
    const taskRepo = this.getTaskWorkspaceRepository();
    if (taskRepo) {
      const taskDoc = await taskRepo.getTaskById(
        actor.projectId,
        normalizedTaskId,
      );
      if (
        !taskDoc ||
        taskDoc.organizationId.toHexString().toLowerCase() !==
          actor.organizationId.toLowerCase() ||
        taskDoc.deletedAt
      ) {
        throw new NotFoundException({
          code: 'TASK_NOT_FOUND',
          message: 'Task not found.',
        });
      }
      return this.mapTaskToActor(
        actor,
        normalizedTaskId,
        this.normalizeTaskDoc(taskDoc),
      );
    }

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
    return this.mapTaskToActor(actor, normalizedTaskId, task);
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
    return this.resolveTaskForActor(headers, actor, taskId.toLowerCase());
  }

  /**
   * BE-PERF-001 / BE-PERF-003: Resolve task metadata/existence for a batch of
   * taskIds using an already-authorized project actor. Uses ONE `$in` MongoDB
   * query in monolith mode (zero loopback HTTP calls, zero repeated IAM auth).
   */
  async resolveTasksBatch(
    headers: CaptureRequestHeaders,
    actor: WorkNotesActor,
    taskIds: readonly string[],
  ): Promise<Map<string, WorkNotesActor | null>> {
    const results = new Map<string, WorkNotesActor | null>();
    const uniqueTaskIds = [
      ...new Set(
        taskIds
          .map((id) => id.trim().toLowerCase())
          .filter((id) => validId(id)),
      ),
    ];
    if (uniqueTaskIds.length === 0) return results;

    const taskRepo = this.getTaskWorkspaceRepository();
    if (taskRepo) {
      for (const id of uniqueTaskIds) {
        results.set(id, null);
      }
      const rows = await taskRepo.db
        .collection<WorkspaceTaskDocument>(WORKSPACE_TASKS_COLLECTION)
        .find(
          {
            _id: { $in: uniqueTaskIds.map((id) => new Types.ObjectId(id)) },
            organizationId: new Types.ObjectId(actor.organizationId),
            projectId: new Types.ObjectId(actor.projectId),
            deletedAt: { $in: [null, undefined] },
          },
          {
            projection: {
              _id: 1,
              organizationId: 1,
              projectId: 1,
              key: 1,
              title: 1,
              description: 1,
              status: 1,
              version: 1,
              parentId: 1,
              steps: 1,
            },
          },
        )
        .toArray();
      for (const doc of rows) {
        const normalizedId = doc._id.toHexString().toLowerCase();
        results.set(
          normalizedId,
          this.mapTaskToActor(actor, normalizedId, this.normalizeTaskDoc(doc)),
        );
      }
      return results;
    }

    // Standalone microservice fallback: reuse already-resolved actor (never re-call resolveProject per task!)
    const concurrency = 6;
    let cursor = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, uniqueTaskIds.length) },
        async () => {
          while (cursor < uniqueTaskIds.length) {
            const candidateId = uniqueTaskIds[cursor];
            cursor += 1;
            try {
              const resolved = await this.resolveTaskForActor(
                headers,
                actor,
                candidateId,
              );
              results.set(candidateId, resolved);
            } catch (err) {
              if (
                err instanceof NotFoundException ||
                err instanceof ForbiddenException
              ) {
                results.set(candidateId, null);
                continue;
              }
              throw err;
            }
          }
        },
      ),
    );
    return results;
  }

  /**
   * Phase-2 history scope: the parent and direct children of the current Task, in the
   * SAME Project/Organization only. Every returned Task was fetched with the caller's own
   * credentials from the Task service, so it is exactly as readable as the current Task
   * (same rule used by `resolveTask` before notes of that Task are listed).
   * Best-effort: any failure degrades to "no related Tasks", never to a broader scope.
   */
  async resolveRelatedTasks(
    headers: CaptureRequestHeaders,
    actor: WorkNotesActor,
    taskId: string,
    options: { maxChildren?: number } = {},
  ): Promise<RelatedTaskRef[]> {
    if (!validId(taskId)) return [];
    const normalizedTaskId = taskId.toLowerCase();
    const prefix = this.config.get<string>('TASK_SERVICE_URL') ? '' : '/api/v1';
    const base = `${prefix}/internal/tasks/projects/${actor.projectId}/tasks`;
    const maxChildren = Math.max(1, Math.min(options.maxChildren ?? 20, 50));
    const related: RelatedTaskRef[] = [];
    const accept = (
      task: Record<string, unknown> | null | undefined,
      relation: RelatedTaskRef['relation'],
    ) => {
      if (!task || typeof task.id !== 'string' || !validId(task.id)) return;
      if (String(task.projectId).toLowerCase() !== actor.projectId) return;
      const id = task.id.toLowerCase();
      if (id === normalizedTaskId || related.some((r) => r.id === id)) return;
      const title = typeof task.title === 'string' ? task.title.trim() : '';
      if (!title) return;
      related.push({
        id,
        title,
        relation,
        ...(typeof task.key === 'string' && task.key.trim()
          ? { key: task.key.trim() }
          : {}),
      });
    };
    if (actor.taskParentId) {
      try {
        const parent = await this.request<Record<string, unknown>>(
          `${base}/${actor.taskParentId}`,
          headers,
          { service: 'task', allowForbidden: true },
        );
        if (parent && String(parent.id).toLowerCase() === actor.taskParentId) {
          accept(parent, 'PARENT');
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err;
      }
    }
    try {
      const children = await this.request<{
        items?: Array<Record<string, unknown>>;
      }>(
        `${base}?${new URLSearchParams({ parentId: normalizedTaskId, limit: String(maxChildren) })}`,
        headers,
        { service: 'task', allowForbidden: true },
      );
      for (const child of children?.items ?? []) {
        if (String(child.parentId).toLowerCase() === normalizedTaskId) {
          accept(child, 'CHILD');
        }
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
    }
    return related;
  }

  /**
   * BE-PERF-003: Fetch active project members and leaders in one combined pass
   * (parallelizing memberships page 1 + leaders) instead of separate redundant
   * IAM roster traversals.
   */
  async listActiveRoster(
    actor: WorkNotesActor,
    headers: CaptureRequestHeaders,
  ): Promise<{
    members: Array<{ userId: string; fullName: string; joinedAt: string }>;
    leaders: Array<{ userId: string; fullName: string; joinedAt: string }>;
  }> {
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

    // BE-PERF-003: In monolith mode, read active roster directly via IAM
    // MongoDB connection in 2 small parallel batches (0 loopback HTTP calls).
    const iamDb = this.iamConnection?.db;
    if (iamDb && validId(actor.organizationId) && validId(actor.projectId)) {
      const orgObjId = new Types.ObjectId(actor.organizationId.toLowerCase());
      const projObjId = new Types.ObjectId(actor.projectId.toLowerCase());
      const [projectMemberships, leaderAssignments] = await Promise.all([
        iamDb
          .collection('project_memberships')
          .find(
            {
              organizationId: orgObjId,
              projectId: projObjId,
              status: 'ACTIVE',
            },
            { projection: { userId: 1, joinedAt: 1, reactivatedAt: 1 } },
          )
          .toArray(),
        iamDb
          .collection('role_assignments')
          .find(
            {
              organizationId: orgObjId,
              projectId: projObjId,
              roleCode: 'TEAM_LEADER',
              status: { $ne: 'REVOKED' },
              revokedAt: { $in: [null, undefined] },
            },
            { projection: { userId: 1, roleId: 1 } },
          )
          .toArray(),
      ]);

      const userObjIds = [
        ...new Set(
          projectMemberships
            .map((m) => String(m.userId ?? '').toLowerCase())
            .filter(validId),
        ),
      ].map((id) => new Types.ObjectId(id));
      const roleObjIds = [
        ...new Set(
          leaderAssignments
            .map((r) => String(r.roleId ?? '').toLowerCase())
            .filter(validId),
        ),
      ].map((id) => new Types.ObjectId(id));

      const [orgMemberships, activeUsers, validLeaderRoles] = await Promise.all(
        [
          userObjIds.length > 0
            ? iamDb
                .collection('organization_memberships')
                .find(
                  {
                    organizationId: orgObjId,
                    userId: { $in: userObjIds },
                    status: 'ACTIVE',
                  },
                  { projection: { userId: 1 } },
                )
                .toArray()
            : Promise.resolve([]),
          userObjIds.length > 0
            ? iamDb
                .collection('users')
                .find(
                  { _id: { $in: userObjIds }, status: 'ACTIVE' },
                  { projection: { _id: 1, fullName: 1, name: 1, email: 1 } },
                )
                .toArray()
            : Promise.resolve([]),
          roleObjIds.length > 0
            ? iamDb
                .collection('roles')
                .find(
                  { _id: { $in: roleObjIds }, code: 'TEAM_LEADER' },
                  { projection: { _id: 1 } },
                )
                .toArray()
            : Promise.resolve([]),
        ],
      );

      const activeOrgUserIds = new Set(
        orgMemberships.map((row) => String(row.userId).toLowerCase()),
      );
      const userById = new Map<string, string>();
      for (const u of activeUsers) {
        const uid = String(u._id).toLowerCase();
        const displayName =
          (typeof u.fullName === 'string' && u.fullName.trim()) ||
          (typeof u.name === 'string' && u.name.trim()) ||
          (typeof u.email === 'string' && u.email.trim()) ||
          uid;
        userById.set(uid, displayName);
      }
      const validLeaderRoleIds = new Set(
        validLeaderRoles.map((r) => String(r._id).toLowerCase()),
      );
      const leaderUserIds = new Set(
        leaderAssignments
          .filter(
            (a) =>
              !a.roleId ||
              validLeaderRoleIds.has(String(a.roleId).toLowerCase()),
          )
          .map((a) => String(a.userId).toLowerCase()),
      );

      const members: Array<{
        userId: string;
        fullName: string;
        joinedAt: string;
      }> = [];
      const leaders: Array<{
        userId: string;
        fullName: string;
        joinedAt: string;
      }> = [];
      for (const membership of projectMemberships) {
        const uid = String(membership.userId ?? '').toLowerCase();
        if (!validId(uid) || !activeOrgUserIds.has(uid) || !userById.has(uid)) {
          continue;
        }
        const joinedIso =
          membership.joinedAt instanceof Date
            ? membership.joinedAt.toISOString()
            : typeof membership.joinedAt === 'string'
              ? membership.joinedAt
              : undefined;
        const reactivatedIso =
          membership.reactivatedAt instanceof Date
            ? membership.reactivatedAt.toISOString()
            : typeof membership.reactivatedAt === 'string'
              ? membership.reactivatedAt
              : undefined;
        const effectiveJoinedAt =
          resolveEffectiveJoinedAt(
            { joinedAt: joinedIso, reactivatedAt: reactivatedIso },
            fallbackJoinedAt,
          ) ?? fallbackJoinedAt;
        const entry = {
          userId: uid,
          fullName: userById.get(uid) ?? uid,
          joinedAt: effectiveJoinedAt,
        };
        if (leaderUserIds.has(uid)) {
          leaders.push(entry);
        } else {
          members.push(entry);
        }
      }
      return { members, leaders };
    }

    const membersMap = new Map<
      string,
      { fullName: string; joinedAt: string }
    >();
    const [firstPage, leadersResponse] = await Promise.all([
      this.request<MembershipResponse>(
        `/api/v1/iam/projects/${actor.projectId}/memberships?page=1&pageSize=100&status=ACTIVE`,
        headers,
      ),
      this.request<{
        data?: Array<{
          userId?: string;
          fullName?: string;
          email?: string;
          status?: string;
        }>;
      }>(`/api/v1/iam/projects/${actor.projectId}/leaders`, headers),
    ]);

    if (
      !Array.isArray(firstPage?.data) ||
      !Array.isArray(leadersResponse?.data)
    ) {
      throw this.membersUnavailable();
    }

    const ingestPage = (result: MembershipResponse) => {
      for (const membership of result.data ?? []) {
        if (validId(membership.userId ?? '')) {
          const userId = membership.userId!.toLowerCase();
          const resolvedJoinedAt =
            resolveEffectiveJoinedAt(membership, fallbackJoinedAt) ??
            fallbackJoinedAt;
          membersMap.set(userId, {
            fullName:
              membership.user?.fullName?.trim() ||
              membership.user?.email?.trim() ||
              userId,
            joinedAt: resolvedJoinedAt,
          });
        }
      }
    };

    ingestPage(firstPage);
    const totalPages = firstPage.pagination?.totalPages ?? 1;
    if (
      !Number.isSafeInteger(totalPages) ||
      totalPages < 1 ||
      totalPages > 1000
    ) {
      throw this.membersUnavailable();
    }

    for (let page = 2; page <= totalPages; page += 1) {
      const result = await this.request<MembershipResponse>(
        `/api/v1/iam/projects/${actor.projectId}/memberships?page=${page}&pageSize=100&status=ACTIVE`,
        headers,
      );
      if (!Array.isArray(result?.data)) {
        throw this.membersUnavailable();
      }
      ingestPage(result);
    }

    const leaderIds = new Set<string>();
    const leaders: Array<{
      userId: string;
      fullName: string;
      joinedAt: string;
    }> = [];
    for (const leader of leadersResponse.data) {
      if (leader.status !== undefined && leader.status !== 'ACTIVE') continue;
      if (typeof leader.userId !== 'string' || !validId(leader.userId)) {
        continue;
      }
      const userId = leader.userId.toLowerCase();
      leaderIds.add(userId);
      const memberEntry = membersMap.get(userId);
      leaders.push({
        userId,
        fullName:
          leader.fullName?.trim() ||
          memberEntry?.fullName ||
          leader.email?.trim() ||
          userId,
        joinedAt: memberEntry?.joinedAt ?? fallbackJoinedAt,
      });
    }

    const members = [...membersMap.entries()]
      .filter(([userId]) => !leaderIds.has(userId))
      .map(([userId, membership]) => ({ userId, ...membership }));

    return { members, leaders };
  }

  async listActiveMembers(
    actor: WorkNotesActor,
    headers: CaptureRequestHeaders,
  ): Promise<Array<{ userId: string; fullName: string; joinedAt: string }>> {
    const roster = await this.listActiveRoster(actor, headers);
    return roster.members;
  }

  async listActiveLeaders(
    actor: WorkNotesActor,
    headers: CaptureRequestHeaders,
  ): Promise<Array<{ userId: string; fullName: string; joinedAt: string }>> {
    const roster = await this.listActiveRoster(actor, headers);
    return roster.leaders;
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
          const effectiveJoinedAt = resolveEffectiveJoinedAt(membership);
          if (!effectiveJoinedAt) {
            throw this.membersUnavailable();
          }
          return effectiveJoinedAt;
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
    if (incoming.organizationId) {
      headers.set('x-organization-id', incoming.organizationId);
      headers.set(EXPECTED_ORGANIZATION_ID_HEADER, incoming.organizationId);
    }
    if (incoming.requestId) headers.set('x-request-id', incoming.requestId);

    let response: Response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        method: 'GET',
        headers,
        cache: 'no-store',
        redirect: 'error',
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
