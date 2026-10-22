/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { type INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../../../bootstrap';
import { TaskWorkspaceController } from './task-workspace.controller';
import {
  TASK_WORKSPACE_IAM_BRIDGE,
  type TaskWorkspaceIamBridgePort,
  type WorkspaceOrgAdminContext,
  type WorkspaceProjectContext,
} from './task-workspace-iam.bridge';
import {
  TASK_WORKSPACE_REPOSITORY,
  type ListTasksFilter,
} from './task-workspace.repository';
import { TaskWorkspaceService } from './task-workspace.service';
import type {
  WorkspaceChecklistStep,
  WorkspaceIdempotencyRecord,
  WorkspaceProjectSprintDocument,
  WorkspaceSprintStatus,
  WorkspaceSubtaskCounts,
  WorkspaceTaskCommentDocument,
  WorkspaceTaskDocument,
  WorkspaceTaskEventRecord,
  WorkspaceTaskPriority,
  WorkspaceTaskStatus,
  WorkspaceTaskType,
  WorkspaceTaskWorklogDocument,
} from './task-workspace.types';

class InMemoryTaskWorkspaceRepository {
  readonly tasks = new Map<string, WorkspaceTaskDocument>();
  readonly events: WorkspaceTaskEventRecord[] = [];
  readonly comments: WorkspaceTaskCommentDocument[] = [];
  readonly worklogs: WorkspaceTaskWorklogDocument[] = [];
  readonly sprints = new Map<string, WorkspaceProjectSprintDocument>();
  readonly idempotency = new Map<string, WorkspaceIdempotencyRecord>();
  readonly counters = new Map<string, number>();

  async findIdempotency(
    actorId: string,
    projectId: string,
    operationId: string,
  ): Promise<WorkspaceIdempotencyRecord | null> {
    return (
      this.idempotency.get(`${actorId}:${projectId}:${operationId}`) ?? null
    );
  }

  async saveIdempotency(record: {
    actorId: string;
    projectId: string;
    operationId: string;
    fingerprint: string;
    taskId: Types.ObjectId;
    statusCode: number;
    body: unknown;
    etag?: string;
    location?: string;
  }): Promise<void> {
    const now = new Date();
    this.idempotency.set(
      `${record.actorId}:${record.projectId}:${record.operationId}`,
      {
        _id: new Types.ObjectId(),
        actorId: new Types.ObjectId(record.actorId),
        projectId: new Types.ObjectId(record.projectId),
        operationId: record.operationId,
        fingerprint: record.fingerprint,
        state: 'COMMITTED',
        taskId: record.taskId,
        createdAt: now,
        updatedAt: now,
        leaseUntil: now,
        expiresAt: new Date(now.getTime() + 86400_000),
        httpResponse: {
          statusCode: record.statusCode,
          body: record.body,
          etag: record.etag,
          location: record.location,
        },
      },
    );
  }

  async listTasks(
    filter: ListTasksFilter,
  ): Promise<{ items: WorkspaceTaskDocument[]; isDateRange: boolean }> {
    const isDateRange = Boolean(filter.dueFrom || filter.dueTo);
    let docs = [...this.tasks.values()].filter(
      (t) => t.organizationId.toHexString() === filter.organizationId,
    );
    if (filter.projectId) {
      docs = docs.filter((t) => t.projectId.toHexString() === filter.projectId);
    }
    if (filter.statuses?.length) {
      docs = docs.filter((t) => filter.statuses!.includes(t.status));
    }
    if (filter.assigneeId !== undefined) {
      docs = docs.filter((t) =>
        filter.assigneeId === 'none'
          ? t.assigneeId === null
          : t.assigneeId?.toHexString() === filter.assigneeId,
      );
    }
    if (filter.priorities?.length) {
      docs = docs.filter((t) => filter.priorities!.includes(t.priority));
    }
    if (filter.types?.length) {
      docs = docs.filter((t) => filter.types!.includes(t.type));
    }
    if (filter.parentId !== undefined) {
      docs = docs.filter((t) =>
        filter.parentId === 'none'
          ? t.parentId === null
          : t.parentId?.toHexString() === filter.parentId,
      );
    }
    if (filter.sprintId !== undefined) {
      docs = docs.filter((t) =>
        filter.sprintId === 'none'
          ? t.sprintId === null
          : t.sprintId?.toHexString() === filter.sprintId,
      );
    }
    if (filter.dueDateNone) {
      docs = docs.filter((t) => t.dueDate === null);
    }
    if (filter.dueFrom) {
      docs = docs.filter(
        (t) => t.dueDate !== null && t.dueDate >= filter.dueFrom!,
      );
    }
    if (filter.dueTo) {
      docs = docs.filter(
        (t) => t.dueDate !== null && t.dueDate < filter.dueTo!,
      );
    }
    if (filter.q) {
      const qLower = filter.q.toLowerCase();
      docs = docs.filter(
        (t) =>
          t.key.toLowerCase() === qLower ||
          t.title.toLowerCase().includes(qLower),
      );
    }

    docs.sort((a, b) => {
      if (isDateRange) {
        const da = a.dueDate?.getTime() ?? 0;
        const db = b.dueDate?.getTime() ?? 0;
        if (da !== db) return da - db;
      }
      return a._id.toHexString().localeCompare(b._id.toHexString());
    });

    if (isDateRange && filter.dateCursor) {
      const curTime = filter.dateCursor.dueDate.getTime();
      const curId = filter.dateCursor.id;
      docs = docs.filter((t) => {
        const dt = t.dueDate?.getTime() ?? 0;
        if (dt !== curTime) return dt > curTime;
        return t._id.toHexString() > curId;
      });
    } else if (!isDateRange && filter.afterId) {
      docs = docs.filter((t) => t._id.toHexString() > filter.afterId!);
    }

    return { items: docs.slice(0, filter.limit), isDateRange };
  }

  async getSubtaskCountsMap(
    _projectIds: Types.ObjectId[],
    parentIds: Types.ObjectId[],
  ): Promise<Map<string, WorkspaceSubtaskCounts>> {
    const set = new Set(parentIds.map((id) => id.toHexString()));
    const map = new Map<string, WorkspaceSubtaskCounts>();
    for (const t of this.tasks.values()) {
      if (!t.parentId) continue;
      const pHex = t.parentId.toHexString();
      if (!set.has(pHex)) continue;
      const curr = map.get(pHex) ?? { total: 0, done: 0 };
      curr.total += 1;
      if (t.status === 'DONE') curr.done += 1;
      map.set(pHex, curr);
    }
    return map;
  }

  async getTaskById(
    projectId: string,
    taskId: string,
  ): Promise<WorkspaceTaskDocument | null> {
    const doc = this.tasks.get(taskId);
    if (!doc || doc.projectId.toHexString() !== projectId) return null;
    return doc;
  }

  async countSubtasksOfTask(
    projectId: string,
    parentId: string,
  ): Promise<number> {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (
        t.projectId.toHexString() === projectId &&
        t.parentId?.toHexString() === parentId
      ) {
        count += 1;
      }
    }
    return count;
  }

  async createTaskWithEvent(input: {
    organizationId: string;
    projectId: string;
    projectCode: string;
    actorId: string;
    operationId: string;
    correlationId: string;
    title: string;
    description: string | null;
    type: WorkspaceTaskType;
    priority: WorkspaceTaskPriority;
    assigneeId: string | null;
    parentId: string | null;
    sprintId: string | null;
    labels: string[];
    steps: WorkspaceChecklistStep[];
    dueDate: Date | null;
    startDate: Date | null;
  }): Promise<WorkspaceTaskDocument> {
    const seq = (this.counters.get(input.projectId) ?? 0) + 1;
    this.counters.set(input.projectId, seq);
    const now = new Date();
    const id = new Types.ObjectId();
    const doc: WorkspaceTaskDocument = {
      _id: id,
      organizationId: new Types.ObjectId(input.organizationId),
      projectId: new Types.ObjectId(input.projectId),
      key: `${input.projectCode}-${seq}`,
      title: input.title,
      description: input.description,
      type: input.type,
      status: 'TODO',
      priority: input.priority,
      assigneeId: input.assigneeId
        ? new Types.ObjectId(input.assigneeId)
        : null,
      createdBy: new Types.ObjectId(input.actorId),
      parentId: input.parentId ? new Types.ObjectId(input.parentId) : null,
      sprintId: input.sprintId ? new Types.ObjectId(input.sprintId) : null,
      labels: input.labels,
      steps: input.steps,
      dueDate: input.dueDate,
      startDate: input.startDate,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.tasks.set(id.toHexString(), doc);
    this.events.push({
      _id: new Types.ObjectId(),
      taskId: id,
      projectId: doc.projectId,
      organizationId: doc.organizationId,
      eventName: 'TASK_CREATED',
      eventType: 'TASK_CREATED',
      actorType: 'USER',
      actorId: doc.createdBy,
      source: 'HUMAN',
      changedFields: [
        'projectId',
        'title',
        'createdBy',
        'createdAt',
        'updatedAt',
        'version',
      ],
      taskVersion: 1,
      version: 1,
      occurredAt: now,
      timestamp: now,
      operationId: input.operationId,
      correlationId: input.correlationId,
    });
    return doc;
  }

  async updateTaskFields(input: {
    organizationId: string;
    projectId: string;
    taskId: string;
    actorId: string;
    expectedVersion: number;
    correlationId: string;
    updates: Record<string, unknown>;
    changedFields: string[];
    fromSprintId?: Types.ObjectId | null;
    toSprintId?: Types.ObjectId | null;
  }) {
    const existing = await this.getTaskById(input.projectId, input.taskId);
    if (!existing) return { kind: 'NOT_FOUND' as const };
    if (existing.version !== input.expectedVersion) {
      return {
        kind: 'CONFLICT' as const,
        currentVersion: existing.version,
        currentStatus: existing.status,
      };
    }
    const now = new Date();
    const updated: WorkspaceTaskDocument = {
      ...existing,
      ...(input.updates as Partial<WorkspaceTaskDocument>),
      updatedAt: now,
      version: existing.version + 1,
    };
    this.tasks.set(input.taskId, updated);
    this.events.push({
      _id: new Types.ObjectId(),
      taskId: updated._id,
      projectId: updated.projectId,
      organizationId: updated.organizationId,
      eventType: 'TASK_UPDATED',
      actorId: new Types.ObjectId(input.actorId),
      actorType: 'USER',
      source: 'WEB',
      operationId: new Types.ObjectId().toHexString(),
      correlationId: input.correlationId,
      occurredAt: now,
      timestamp: now,
      version: updated.version,
      changedFields: input.changedFields,
      delta: {
        type: 'FIELD_UPDATE',
        changedFields: input.changedFields,
        fromSprintId: input.fromSprintId,
        toSprintId: input.toSprintId,
      },
    });
    return { kind: 'UPDATED' as const, task: updated };
  }

  async transitionTaskStatus(input: {
    organizationId: string;
    projectId: string;
    taskId: string;
    actorId: string;
    expectedVersion: number;
    fromStatus: WorkspaceTaskStatus;
    toStatus: WorkspaceTaskStatus;
    reason?: string;
    operationId: string;
    correlationId: string;
  }) {
    const existing = await this.getTaskById(input.projectId, input.taskId);
    if (!existing) return { kind: 'NOT_FOUND' as const };
    if (
      existing.version !== input.expectedVersion ||
      existing.status !== input.fromStatus
    ) {
      return {
        kind: 'CONFLICT' as const,
        currentVersion: existing.version,
        currentStatus: existing.status,
      };
    }
    const now = new Date();
    const updated: WorkspaceTaskDocument = {
      ...existing,
      status: input.toStatus,
      completedAt: input.toStatus === 'DONE' ? now : null,
      updatedAt: now,
      version: existing.version + 1,
    };
    this.tasks.set(input.taskId, updated);
    this.events.push({
      _id: new Types.ObjectId(),
      taskId: updated._id,
      projectId: updated.projectId,
      organizationId: updated.organizationId,
      eventType: 'TASK_STATUS_TRANSITIONED',
      actorId: new Types.ObjectId(input.actorId),
      actorType: 'USER',
      source: 'WEB',
      operationId: input.operationId,
      correlationId: input.correlationId,
      occurredAt: now,
      timestamp: now,
      version: updated.version,
      changedFields: ['status'],
      delta: {
        type: 'STATUS_TRANSITION',
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        reason: input.reason,
      },
    });
    return { kind: 'UPDATED' as const, task: updated };
  }

  async listTaskHistory(
    projectId: string,
    taskId: string,
    page: number,
    limit: number,
  ) {
    const matching = this.events
      .filter(
        (e) =>
          e.projectId.toHexString() === projectId &&
          e.taskId.toHexString() === taskId,
      )
      .slice()
      .reverse();
    const skip = (page - 1) * limit;
    const slice = matching.slice(skip, skip + limit + 1);
    const hasNext = slice.length > limit;
    return {
      events: hasNext ? slice.slice(0, limit) : slice,
      hasNext,
    };
  }

  async listTaskComments(
    projectId: string,
    taskId: string,
    limit: number,
    afterId?: string,
  ) {
    let rows = this.comments.filter(
      (c) =>
        c.projectId.toHexString() === projectId &&
        c.taskId.toHexString() === taskId,
    );
    if (afterId) {
      rows = rows.filter((c) => c._id.toHexString() > afterId);
    }
    return rows.slice(0, limit);
  }

  async createTaskComment(input: {
    organizationId: string;
    projectId: string;
    taskId: string;
    taskVersion: number;
    authorId: string;
    body: string;
    operationId: string;
    correlationId: string;
  }) {
    const now = new Date();
    const comment: WorkspaceTaskCommentDocument = {
      _id: new Types.ObjectId(),
      taskId: new Types.ObjectId(input.taskId),
      projectId: new Types.ObjectId(input.projectId),
      organizationId: new Types.ObjectId(input.organizationId),
      authorId: new Types.ObjectId(input.authorId),
      body: input.body,
      createdAt: now,
    };
    this.comments.push(comment);
    this.events.push({
      _id: new Types.ObjectId(),
      taskId: comment.taskId,
      projectId: comment.projectId,
      organizationId: comment.organizationId,
      eventType: 'TASK_COMMENT_ADDED',
      actorId: comment.authorId,
      actorType: 'USER',
      source: 'WEB',
      operationId: input.operationId,
      correlationId: input.correlationId,
      occurredAt: now,
      timestamp: now,
      version: input.taskVersion,
      delta: { type: 'COMMENT_ADDED', commentId: comment._id },
    });
    return comment;
  }

  async listTaskWorklogs(
    projectId: string,
    taskId: string,
    limit: number,
    afterId?: string,
  ) {
    const all = this.worklogs
      .filter(
        (w) =>
          w.projectId.toHexString() === projectId &&
          w.taskId.toHexString() === taskId,
      )
      .slice()
      .reverse();
    const totalMinutes = all.reduce((sum, w) => sum + w.minutes, 0);
    const filtered = afterId
      ? all.filter((w) => w._id.toHexString() < afterId)
      : all;
    return {
      items: filtered.slice(0, limit),
      totalMinutes,
    };
  }

  async createTaskWorklog(input: {
    organizationId: string;
    projectId: string;
    taskId: string;
    taskVersion: number;
    authorId: string;
    minutes: number;
    note: string | null;
    loggedAt: Date;
    operationId: string;
    correlationId: string;
  }) {
    const now = new Date();
    const worklog: WorkspaceTaskWorklogDocument = {
      _id: new Types.ObjectId(),
      taskId: new Types.ObjectId(input.taskId),
      projectId: new Types.ObjectId(input.projectId),
      organizationId: new Types.ObjectId(input.organizationId),
      authorId: new Types.ObjectId(input.authorId),
      minutes: input.minutes,
      note: input.note,
      loggedAt: input.loggedAt,
      createdAt: now,
    };
    this.worklogs.push(worklog);
    this.events.push({
      _id: new Types.ObjectId(),
      taskId: worklog.taskId,
      projectId: worklog.projectId,
      organizationId: worklog.organizationId,
      eventType: 'TASK_WORKLOG_ADDED',
      actorId: worklog.authorId,
      actorType: 'USER',
      source: 'WEB',
      operationId: input.operationId,
      correlationId: input.correlationId,
      occurredAt: now,
      timestamp: now,
      version: input.taskVersion,
      delta: {
        type: 'WORKLOG_ADDED',
        worklogId: worklog._id,
        minutes: input.minutes,
      },
    });
    return worklog;
  }

  async getSprintById(projectId: string, sprintId: string) {
    const s = this.sprints.get(sprintId);
    if (!s || s.projectId.toHexString() !== projectId) return null;
    return s;
  }

  async listProjectSprints(projectId: string, status?: WorkspaceSprintStatus) {
    let list = [...this.sprints.values()].filter(
      (s) => s.projectId.toHexString() === projectId,
    );
    if (status) list = list.filter((s) => s.status === status);
    return list.map((sprint) => {
      const sprintTasks = [...this.tasks.values()].filter(
        (t) =>
          t.projectId.toHexString() === projectId &&
          t.sprintId?.toHexString() === sprint._id.toHexString(),
      );
      return {
        sprint,
        counts: {
          totalTasks: sprintTasks.length,
          doneTasks: sprintTasks.filter((t) => t.status === 'DONE').length,
          inProgressTasks: sprintTasks.filter((t) =>
            ['IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'].includes(t.status),
          ).length,
          todoTasks: sprintTasks.filter((t) => t.status === 'TODO').length,
        },
      };
    });
  }

  async createProjectSprint(input: {
    organizationId: string;
    projectId: string;
    actorId: string;
    name: string;
    goal: string | null;
    startDate: Date | null;
    endDate: Date | null;
  }) {
    const id = new Types.ObjectId();
    const sprint: WorkspaceProjectSprintDocument = {
      _id: id,
      projectId: new Types.ObjectId(input.projectId),
      organizationId: new Types.ObjectId(input.organizationId),
      name: input.name,
      goal: input.goal,
      status: 'PLANNED',
      startDate: input.startDate,
      endDate: input.endDate,
      createdBy: new Types.ObjectId(input.actorId),
      createdAt: new Date(),
      completedAt: null,
      version: 1,
    };
    this.sprints.set(id.toHexString(), sprint);
    return sprint;
  }

  async updateProjectSprint(input: {
    organizationId: string;
    projectId: string;
    sprintId: string;
    actorId: string;
    expectedVersion: number;
    updates: Partial<{
      name: string;
      goal: string | null;
      status: 'PLANNED' | 'ACTIVE';
      startDate: Date | null;
      endDate: Date | null;
    }>;
  }) {
    const existing = await this.getSprintById(input.projectId, input.sprintId);
    if (!existing) return { kind: 'NOT_FOUND' as const };
    if (existing.version !== input.expectedVersion) {
      return {
        kind: 'VERSION_CONFLICT' as const,
        currentVersion: existing.version,
      };
    }
    if (input.updates.status === 'ACTIVE') {
      const otherActive = [...this.sprints.values()].find(
        (s) =>
          s.projectId.toHexString() === input.projectId &&
          s.status === 'ACTIVE' &&
          s._id.toHexString() !== input.sprintId,
      );
      if (otherActive) return { kind: 'ALREADY_ACTIVE' as const };
    }
    const updated: WorkspaceProjectSprintDocument = {
      ...existing,
      ...input.updates,
      version: existing.version + 1,
    };
    this.sprints.set(input.sprintId, updated);
    return { kind: 'UPDATED' as const, sprint: updated };
  }

  async completeProjectSprint(input: {
    organizationId: string;
    projectId: string;
    sprintId: string;
    actorId: string;
    expectedVersion: number;
    moveIncompleteToSprintId: string | null;
    correlationId: string;
  }) {
    const existing = await this.getSprintById(input.projectId, input.sprintId);
    if (!existing) return { kind: 'NOT_FOUND' as const };
    if (existing.version !== input.expectedVersion) {
      return {
        kind: 'VERSION_CONFLICT' as const,
        currentVersion: existing.version,
      };
    }
    if (existing.status !== 'ACTIVE') return { kind: 'NOT_ACTIVE' as const };
    if (input.moveIncompleteToSprintId) {
      const target = await this.getSprintById(
        input.projectId,
        input.moveIncompleteToSprintId,
      );
      if (!target || target.status !== 'PLANNED') {
        return { kind: 'TARGET_SPRINT_INVALID' as const };
      }
    }
    const now = new Date();
    const completedSprint: WorkspaceProjectSprintDocument = {
      ...existing,
      status: 'COMPLETED',
      completedAt: now,
      version: existing.version + 1,
    };
    this.sprints.set(input.sprintId, completedSprint);

    const targetObjId = input.moveIncompleteToSprintId
      ? new Types.ObjectId(input.moveIncompleteToSprintId)
      : null;

    for (const [tId, task] of this.tasks.entries()) {
      if (
        task.projectId.toHexString() === input.projectId &&
        task.sprintId?.toHexString() === input.sprintId &&
        task.status !== 'DONE' &&
        task.status !== 'CANCELLED'
      ) {
        const nextVersion = task.version + 1;
        this.tasks.set(tId, {
          ...task,
          sprintId: targetObjId,
          updatedAt: now,
          version: nextVersion,
        });
        this.events.push({
          _id: new Types.ObjectId(),
          taskId: task._id,
          projectId: task.projectId,
          organizationId: task.organizationId,
          eventType: 'TASK_UPDATED',
          actorId: new Types.ObjectId(input.actorId),
          actorType: 'USER',
          source: 'WEB',
          operationId: new Types.ObjectId().toHexString(),
          correlationId: input.correlationId,
          occurredAt: now,
          timestamp: now,
          version: nextVersion,
          changedFields: ['sprintId'],
          delta: {
            type: 'FIELD_UPDATE',
            changedFields: ['sprintId'],
            fromSprintId: existing._id,
            toSprintId: targetObjId,
            reason: 'SPRINT_COMPLETED',
          },
        });
      }
    }

    return { kind: 'COMPLETED' as const, sprint: completedSprint };
  }

  async getProjectTaskSummary(
    organizationId: string,
    projectId: string,
    asOf: Date,
  ) {
    const projectTasks = [...this.tasks.values()].filter(
      (t) =>
        t.organizationId.toHexString() === organizationId &&
        t.projectId.toHexString() === projectId,
    );
    const byStatusMap = new Map<string, number>();
    const byPriorityMap = new Map<string, number>();
    const byTypeMap = new Map<string, number>();
    for (const t of projectTasks) {
      byStatusMap.set(t.status, (byStatusMap.get(t.status) ?? 0) + 1);
      byPriorityMap.set(t.priority, (byPriorityMap.get(t.priority) ?? 0) + 1);
      byTypeMap.set(t.type, (byTypeMap.get(t.type) ?? 0) + 1);
    }
    return {
      asOf: asOf.toISOString(),
      total: projectTasks.length,
      byStatus: [...byStatusMap.entries()].map(([key, count]) => ({
        key,
        count,
      })),
      byPriority: [...byPriorityMap.entries()].map(([key, count]) => ({
        key,
        count,
      })),
      byType: [...byTypeMap.entries()].map(([key, count]) => ({
        key,
        count,
      })),
      byAssignee: [],
      overdue: 0,
      dueNext7Days: 0,
      completedLast7Days: projectTasks.filter((t) => t.status === 'DONE')
        .length,
      createdLast7Days: projectTasks.length,
    };
  }

  async getOrganizationTaskAggregates(organizationId: string, asOf: Date) {
    const orgTasks = [...this.tasks.values()].filter(
      (t) => t.organizationId.toHexString() === organizationId,
    );
    const statusBuckets: Array<{
      _id: { p: Types.ObjectId; s: WorkspaceTaskStatus };
      n: number;
    }> = [];
    const overdueBuckets: Array<{ _id: Types.ObjectId; n: number }> = [];

    for (const t of orgTasks) {
      statusBuckets.push({
        _id: { p: t.projectId, s: t.status },
        n: 1,
      });
      if (
        t.dueDate &&
        t.dueDate < asOf &&
        !['DONE', 'CANCELLED'].includes(t.status)
      ) {
        overdueBuckets.push({ _id: t.projectId, n: 1 });
      }
    }
    return { statusBuckets, overdueBuckets };
  }
}

describe('TaskWorkspaceController (17 Workspace Task API endpoints)', () => {
  let app: INestApplication;
  let httpServer: App;
  let repo: InMemoryTaskWorkspaceRepository;

  const orgId = '65f000000000000000000001';
  const projectId = '65f000000000000000000010';
  const privateProjectId = '65f000000000000000000020';
  const adminUserId = '65f000000000000000000101';
  const leaderUserId = '65f000000000000000000102';
  const memberAId = '65f000000000000000000103';
  const memberBId = '65f000000000000000000104';
  const outsiderUserId = '65f000000000000000000199';

  const csrfToken = 'csrf-token-workspace-test-12345';
  const csrfCookie = `continuum_csrf=${csrfToken}`;

  beforeEach(async () => {
    repo = new InMemoryTaskWorkspaceRepository();

    const fakeIamBridge: TaskWorkspaceIamBridgePort = {
      async resolveProjectContext(
        authHeader,
        _cookieHeader,
        targetProjectId,
      ): Promise<WorkspaceProjectContext> {
        const token = authHeader?.replace(/^Bearer\s+/i, '') ?? 'leader';
        if (
          targetProjectId !== projectId &&
          targetProjectId !== privateProjectId
        ) {
          throw new NotFoundException({
            code: 'PROJECT_NOT_FOUND',
            message: 'Project not found.',
          });
        }
        if (token === 'admin') {
          return {
            actorId: adminUserId,
            actorName: 'Thang Manager',
            organizationId: orgId,
            projectId: targetProjectId,
            projectCode:
              targetProjectId === privateProjectId
                ? 'PRIV'
                : ' cntm'.trim().toUpperCase(),
            projectName:
              targetProjectId === privateProjectId
                ? 'Private R&D'
                : 'Continuum Core',
            actorRole: 'ADMIN',
          };
        }
        if (targetProjectId === privateProjectId) {
          throw new NotFoundException({
            code: 'PROJECT_NOT_FOUND',
            message: 'Project not found.',
          });
        }
        if (token === 'leader') {
          return {
            actorId: leaderUserId,
            actorName: 'Phuc Team Leader',
            organizationId: orgId,
            projectId: targetProjectId,
            projectCode: 'CNTM',
            projectName: 'Continuum Core',
            actorRole: 'TEAM_LEADER',
          };
        }
        if (token === 'memberA') {
          return {
            actorId: memberAId,
            actorName: 'Member A',
            organizationId: orgId,
            projectId: targetProjectId,
            projectCode: 'CNTM',
            projectName: 'Continuum Core',
            actorRole: 'MEMBER',
          };
        }
        if (token === 'memberB') {
          return {
            actorId: memberBId,
            actorName: 'Member B',
            organizationId: orgId,
            projectId: targetProjectId,
            projectCode: 'CNTM',
            projectName: 'Continuum Core',
            actorRole: 'MEMBER',
          };
        }
        throw new NotFoundException({
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found.',
        });
      },

      async resolveOrgAdminContext(
        authHeader,
      ): Promise<WorkspaceOrgAdminContext> {
        const token = authHeader?.replace(/^Bearer\s+/i, '') ?? '';
        if (token !== 'admin') {
          throw new NotFoundException({
            code: 'TASK_NOT_FOUND',
            message: 'Resource not found.',
          });
        }
        return {
          actorId: adminUserId,
          actorName: 'Thang Manager',
          organizationId: orgId,
        };
      },

      async isActiveProjectMember(_orgId, _projId, userId): Promise<boolean> {
        return [leaderUserId, memberAId, memberBId].includes(userId);
      },

      async listOrganizationProjects() {
        return [
          { id: projectId, name: 'Continuum Core', code: 'CNTM' },
          { id: privateProjectId, name: 'Private R&D', code: 'PRIV' },
        ];
      },

      async resolveUsersById(userIds) {
        const names: Record<string, string> = {
          [adminUserId]: 'Thang Manager',
          [leaderUserId]: 'Phuc Team Leader',
          [memberAId]: 'Member A',
          [memberBId]: 'Member B',
        };
        const map = new Map<string, { id: string; fullName: string }>();
        for (const id of userIds) {
          if (names[id]) map.set(id, { id, fullName: names[id] });
        }
        return map;
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [TaskWorkspaceController],
      providers: [
        TaskWorkspaceService,
        { provide: TASK_WORKSPACE_REPOSITORY, useValue: repo },
        { provide: TASK_WORKSPACE_IAM_BRIDGE, useValue: fakeIamBridge },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    configureApplication(app);
    await app.init();
    httpServer = app.getHttpServer() as App;
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates tasks idempotently, allocates <CODE>-<seq>, validates subtasks/assignees, and lists with subtaskCounts', async () => {
    const createRes = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-create-task-0001')
      .send({
        title: 'Implement Workspace Task API',
        description: 'Full 17 endpoints in NestJS',
        type: 'STORY',
        priority: 'HIGH',
        assigneeId: memberAId,
        labels: ['backend', 'workspace'],
        steps: [{ id: 's1', text: 'Write controller', done: true }],
      })
      .expect(201);

    expect(createRes.body.key).toBe('CNTM-1');
    expect(createRes.body.version).toBe(1);
    expect(createRes.headers.etag).toBe(`"task:${createRes.body.id}:1"`);

    // Replay with same Idempotency-Key returns Idempotency-Replayed: true and same key CNTM-1
    const replayRes = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-create-task-0001')
      .send({
        title: 'Implement Workspace Task API',
        description: 'Full 17 endpoints in NestJS',
        type: 'STORY',
        priority: 'HIGH',
        assigneeId: memberAId,
        labels: ['backend', 'workspace'],
        steps: [{ id: 's1', text: 'Write controller', done: true }],
      })
      .expect(201);

    expect(replayRes.headers['idempotency-replayed']).toBe('true');
    expect(replayRes.body.id).toBe(createRes.body.id);

    // Reusing Idempotency-Key with different payload -> 409 IDEMPOTENCY_KEY_REUSED
    await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-create-task-0001')
      .send({ title: 'Different payload' })
      .expect(409);

    // Invalid assignee not in project -> 422 ASSIGNEE_NOT_IN_PROJECT
    const badAssignee = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-create-task-bad-assignee')
      .send({ title: 'Out of project assignee', assigneeId: outsiderUserId })
      .expect(422);
    expect(badAssignee.body.code).toBe('ASSIGNEE_NOT_IN_PROJECT');

    // Create child subtask under parent
    const subtaskRes = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-create-subtask-0001')
      .send({
        title: 'Child subtask 1',
        parentId: createRes.body.id,
      })
      .expect(201);
    expect(subtaskRes.body.key).toBe('CNTM-2');

    // Grandchild subtask -> 422 TASK_SUBTASK_DEPTH_EXCEEDED
    const grandChildRes = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-create-grandchild-0001')
      .send({
        title: 'Grandchild subtask',
        parentId: subtaskRes.body.id,
      })
      .expect(422);
    expect(grandChildRes.body.code).toBe('TASK_SUBTASK_DEPTH_EXCEEDED');

    // List top-level tasks and verify subtaskCounts
    const listRes = await request(httpServer)
      .get(`/api/v1/tasks/projects/${projectId}/tasks?parentId=none`)
      .set('Authorization', 'Bearer memberA')
      .expect(200);

    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].subtaskCounts).toEqual({
      total: 1,
      done: 0,
    });
  });

  it('enforces If-Match CAS, member ownership permissions, status transitions (incl. IN_REVIEW and soft-cancel CANCELLED), comments, worklogs, and history', async () => {
    const created = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-workflow-create-0001')
      .send({
        title: 'Member A Task',
        assigneeId: memberAId,
      })
      .expect(201);

    const taskId = created.body.id as string;
    const etagV1 = created.headers.etag;

    // Missing If-Match -> 428
    await request(httpServer)
      .patch(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ title: 'Updated without If-Match' })
      .expect(428);

    // Member B (neither creator nor assignee) cannot PATCH -> 403
    await request(httpServer)
      .patch(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}`)
      .set('Authorization', 'Bearer memberB')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', etagV1)
      .send({ title: 'Unauthorized member edit' })
      .expect(403);

    // Member A updates title -> version 2
    const patchRes = await request(httpServer)
      .patch(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', etagV1)
      .send({ title: 'Member A Task (Refined)', priority: 'HIGH' })
      .expect(200);

    expect(patchRes.body.version).toBe(2);
    const etagV2 = patchRes.headers.etag;

    // Stale ETag v1 -> 409 TASK_VERSION_CONFLICT
    await request(httpServer)
      .patch(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', etagV1)
      .send({ title: 'Stale write' })
      .expect(409);

    // Transition TODO -> IN_PROGRESS -> IN_REVIEW -> DONE
    const tr1 = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}/transitions`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', etagV2)
      .set('Idempotency-Key', 'idem-tr-in-progress-001')
      .send({ fromStatus: 'TODO', toStatus: 'IN_PROGRESS' })
      .expect(200);

    const tr2 = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}/transitions`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', tr1.headers.etag)
      .set('Idempotency-Key', 'idem-tr-in-review-001')
      .send({ fromStatus: 'IN_PROGRESS', toStatus: 'IN_REVIEW' })
      .expect(200);
    expect(tr2.body.status).toBe('IN_REVIEW');

    const tr3 = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}/transitions`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', tr2.headers.etag)
      .set('Idempotency-Key', 'idem-tr-done-001')
      .send({ fromStatus: 'IN_REVIEW', toStatus: 'DONE' })
      .expect(200);
    expect(tr3.body.status).toBe('DONE');
    expect(tr3.body.completedAt).toEqual(expect.any(String));

    // Add comment & worklog
    await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}/comments`)
      .set('Authorization', 'Bearer memberB')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-comment-0001')
      .send({ body: 'Reviewed and verified all edge cases!' })
      .expect(201);

    await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}/worklogs`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-worklog-0001')
      .send({ minutes: 95, note: 'Implemented service and tests' })
      .expect(201);

    const worklogsRes = await request(httpServer)
      .get(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}/worklogs`)
      .set('Authorization', 'Bearer memberA')
      .expect(200);
    expect(worklogsRes.body.totalMinutes).toBe(95);

    const historyRes = await request(httpServer)
      .get(`/api/v1/tasks/projects/${projectId}/tasks/${taskId}/history`)
      .set('Authorization', 'Bearer memberA')
      .expect(200);
    expect(historyRes.body.data.length).toBeGreaterThanOrEqual(6);
    expect(historyRes.body.data[0].actor.fullName).toBe('Member A');
    expect(historyRes.body.pagination).toEqual({
      page: 1,
      limit: 20,
      hasNext: false,
    });
  });

  it('manages sprints with Sprint ETag/If-Match CAS, rolls over incomplete tasks with per-task audit events, and serves Manager Org Overview', async () => {
    // Leader creates Sprint 1 & Sprint 2
    const s1 = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/sprints`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-sprint-create-001')
      .send({ name: 'Sprint 1', goal: 'Core API' })
      .expect(201);
    expect(s1.body.counts).toEqual({
      totalTasks: 0,
      doneTasks: 0,
      inProgressTasks: 0,
      todoTasks: 0,
    });

    const s2 = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/sprints`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-sprint-create-002')
      .send({ name: 'Sprint 2', goal: 'FE Integration' })
      .expect(201);

    // Activate Sprint 1
    const s1Active = await request(httpServer)
      .patch(`/api/v1/tasks/projects/${projectId}/sprints/${s1.body.id}`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', s1.headers.etag)
      .send({ status: 'ACTIVE' })
      .expect(200);

    // Activating Sprint 2 while Sprint 1 is active -> 409 SPRINT_ALREADY_ACTIVE
    const conflictActive = await request(httpServer)
      .patch(`/api/v1/tasks/projects/${projectId}/sprints/${s2.body.id}`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', s2.headers.etag)
      .send({ status: 'ACTIVE' })
      .expect(409);
    expect(conflictActive.body.code).toBe('SPRINT_ALREADY_ACTIVE');

    // Create an incomplete task in Sprint 1
    const taskInS1 = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-task-in-s1-001')
      .send({ title: 'Rollover candidate', sprintId: s1.body.id })
      .expect(201);

    // Complete Sprint 1 and move incomplete tasks to Sprint 2
    const completedS1 = await request(httpServer)
      .post(
        `/api/v1/tasks/projects/${projectId}/sprints/${s1.body.id}/complete`,
      )
      .set('Authorization', 'Bearer leader')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', s1Active.headers.etag)
      .set('Idempotency-Key', 'idem-sprint-complete-001')
      .send({ moveIncompleteToSprintId: s2.body.id })
      .expect(200);
    expect(completedS1.body.status).toBe('COMPLETED');

    // Verify task was moved to Sprint 2, version incremented to 2, and history has SPRINT_COMPLETED reason
    const movedTask = await request(httpServer)
      .get(`/api/v1/tasks/projects/${projectId}/tasks/${taskInS1.body.id}`)
      .set('Authorization', 'Bearer leader')
      .expect(200);
    expect(movedTask.body.sprintId).toBe(s2.body.id);
    expect(movedTask.body.version).toBe(2);

    const movedHistory = await request(httpServer)
      .get(
        `/api/v1/tasks/projects/${projectId}/tasks/${taskInS1.body.id}/history`,
      )
      .set('Authorization', 'Bearer leader')
      .expect(200);
    expect(movedHistory.body.data[0]).toMatchObject({
      type: 'TASK_UPDATED',
      changedFields: ['sprintId'],
      fromSprintId: s1.body.id,
      toSprintId: s2.body.id,
      reason: 'SPRINT_COMPLETED',
    });

    // Manager (ADMIN) can create a task in a PRIVATE project without being a member (Gate G4)
    await request(httpServer)
      .post(`/api/v1/tasks/projects/${privateProjectId}/tasks`)
      .set('Authorization', 'Bearer admin')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-admin-private-proj-001')
      .send({ title: 'Executive Security Audit Task' })
      .expect(201);

    // Manager Organization-wide task list & summary
    const orgTasks = await request(httpServer)
      .get('/api/v1/tasks/organization/tasks')
      .set('Authorization', 'Bearer admin')
      .expect(200);
    expect(orgTasks.body.items).toHaveLength(2);
    expect(orgTasks.body.items[0]).toHaveProperty('projectName');
    expect(orgTasks.body.items[0]).toHaveProperty('projectCode');
    expect(orgTasks.body.items[0]).not.toHaveProperty('organizationId');
    expect(orgTasks.body).toHaveProperty('nextAfterId');
    expect(orgTasks.body).toHaveProperty('nextCursor');

    const orgSummary = await request(httpServer)
      .get('/api/v1/tasks/organization/task-summary')
      .set('Authorization', 'Bearer admin')
      .expect(200);
    expect(orgSummary.body.totals.total).toBe(2);
    expect(orgSummary.body.projects).toHaveLength(2);
    expect(orgSummary.body.projects[0]).toHaveProperty('byStatus');

    // Non-admin gets 404 on organization endpoints
    await request(httpServer)
      .get('/api/v1/tasks/organization/tasks')
      .set('Authorization', 'Bearer leader')
      .expect(404);
  });

  it('enforces strict CSRF double-submit cookie, supports assigneeId=me and optional fromStatus, and rejects unknown query/body parameters', async () => {
    // Missing CSRF cookie even when X-CSRF-Token header is present -> 403 CSRF_TOKEN_INVALID
    const missingCookieRes = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer memberA')
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-csrf-check-001')
      .send({ title: 'Should fail CSRF' })
      .expect(403);
    expect(missingCookieRes.body.code).toBe('CSRF_TOKEN_INVALID');

    // Unknown query parameter -> 422 VALIDATION_FAILED
    const badQueryRes = await request(httpServer)
      .get(`/api/v1/tasks/projects/${projectId}/tasks?unknownParam=1`)
      .set('Authorization', 'Bearer memberA')
      .expect(422);
    expect(badQueryRes.body.code).toBe('VALIDATION_FAILED');

    // Create task assigned to memberA, then filter with assigneeId=me and transition without fromStatus
    const created = await request(httpServer)
      .post(`/api/v1/tasks/projects/${projectId}/tasks`)
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', 'idem-me-filter-001')
      .send({ title: 'My Assigned Task', assigneeId: memberAId })
      .expect(201);

    const meList = await request(httpServer)
      .get(`/api/v1/tasks/projects/${projectId}/tasks?assigneeId=me`)
      .set('Authorization', 'Bearer memberA')
      .expect(200);
    expect(meList.body.items).toHaveLength(1);
    expect(meList.body.items[0].id).toBe(created.body.id);

    const transitioned = await request(httpServer)
      .post(
        `/api/v1/tasks/projects/${projectId}/tasks/${created.body.id}/transitions`,
      )
      .set('Authorization', 'Bearer memberA')
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfToken)
      .set('If-Match', created.headers.etag)
      .set('Idempotency-Key', 'idem-optional-fromstatus-001')
      .send({ toStatus: 'IN_PROGRESS' })
      .expect(200);
    expect(transitioned.body.status).toBe('IN_PROGRESS');
  });
});
