import { Inject, Injectable } from '@nestjs/common';
import {
  TASK_CREATION_CHANGED_FIELDS,
  TASK_STATUSES,
  isObjectIdString,
  type TaskCreationEventDocument,
  type TaskDocument,
  type TaskEventDocument,
  type TaskStatus,
  type TaskStatusTransitionEventDocument,
} from '../infrastructure/mongodb/task-contract';
import {
  TaskAuthorizationBoundary,
  type TaskAuthorizationResult,
} from './task-authorization-boundary';

export const TASK_HISTORY_ACCESS_EVIDENCE_PROVIDER = Symbol(
  'TASK_HISTORY_ACCESS_EVIDENCE_PROVIDER',
);

const DEFAULT_HISTORY_PAGE = 1;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const historyPrincipalKinds = [
  'PROJECT_MEMBER',
  'TEAM_LEADER',
  'SUCCESSOR',
  'ORGANIZATION_ADMIN',
  'PLATFORM_OPERATOR',
] as const;
const creationFieldSet = new Set<string>(TASK_CREATION_CHANGED_FIELDS);
const taskStatusSet = new Set<string>(TASK_STATUSES);
const creationSources = new Set(['HUMAN']);
const transitionSources = new Set(['WEB', 'API', 'INTERNAL_SERVICE']);

export type TaskHistoryPrincipalKind = (typeof historyPrincipalKinds)[number];

type ProjectMembershipStatus = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';

function isProjectMembershipStatus(
  value: unknown,
): value is ProjectMembershipStatus {
  return value === 'ACTIVE' || value === 'INACTIVE' || value === 'UNKNOWN';
}

function isTaskHistoryPrincipalKind(
  value: unknown,
): value is TaskHistoryPrincipalKind {
  return (
    typeof value === 'string' &&
    historyPrincipalKinds.includes(value as TaskHistoryPrincipalKind)
  );
}

export interface TaskHistoryAccessEvidence {
  actorUserId: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  projectMembershipStatus: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';
  /** Explicit Task-level read permission; role names alone never grant it. */
  taskReadPermission: boolean;
  principalKind: TaskHistoryPrincipalKind;
  /** Must be resolved from current Handover state on each successor request. */
  validHandoverAssignment: boolean;
}

export type TaskHistoryAccessEvidenceResult =
  | { kind: 'resolved'; evidence: TaskHistoryAccessEvidence }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

export interface TaskHistoryAccessEvidenceProvider {
  /**
   * Resolve current Project membership, Task read permission and, for a
   * successor, the current Handover assignment. Implementations must not use a
   * stale authorization cache and are called for every history request.
   */
  resolve(
    this: void,
    input: {
      actorUserId: string;
      organizationId: string;
      projectId: string;
      taskId: string;
    },
  ): TaskHistoryAccessEvidenceResult | Promise<TaskHistoryAccessEvidenceResult>;
}

export type TaskHistoryAccessDecision =
  | { kind: 'allowed' }
  | {
      kind: 'denied';
      reason:
        | 'INVALID_REQUEST'
        | 'EVIDENCE_UNAVAILABLE'
        | 'PROJECT_MEMBERSHIP_REQUIRED'
        | 'TASK_PERMISSION_DENIED'
        | 'HANDOVER_ASSIGNMENT_REQUIRED';
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  try {
    const ownKeys = Reflect.ownKeys(value);
    const stringKeys = ownKeys.filter(
      (key): key is string => typeof key === 'string',
    );
    const expected = [...expectedKeys].sort();
    stringKeys.sort();
    if (
      ownKeys.length !== expected.length ||
      stringKeys.length !== expected.length ||
      !stringKeys.every((key, index) => key === expected[index])
    ) {
      return undefined;
    }

    const result = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
        return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function parseAccessEvidence(
  value: unknown,
): TaskHistoryAccessEvidence | undefined {
  const evidence = readExactRecord(value, [
    'actorUserId',
    'organizationId',
    'projectId',
    'taskId',
    'projectMembershipStatus',
    'taskReadPermission',
    'principalKind',
    'validHandoverAssignment',
  ]);
  if (
    !evidence ||
    !isObjectIdString(evidence.actorUserId) ||
    !isObjectIdString(evidence.organizationId) ||
    !isObjectIdString(evidence.projectId) ||
    !isObjectIdString(evidence.taskId) ||
    !isProjectMembershipStatus(evidence.projectMembershipStatus) ||
    typeof evidence.taskReadPermission !== 'boolean' ||
    !isTaskHistoryPrincipalKind(evidence.principalKind) ||
    typeof evidence.validHandoverAssignment !== 'boolean'
  ) {
    return undefined;
  }

  return {
    actorUserId: evidence.actorUserId,
    organizationId: evidence.organizationId,
    projectId: evidence.projectId,
    taskId: evidence.taskId,
    projectMembershipStatus: evidence.projectMembershipStatus,
    taskReadPermission: evidence.taskReadPermission,
    principalKind: evidence.principalKind,
    validHandoverAssignment: evidence.validHandoverAssignment,
  };
}

@Injectable()
export class UnconfiguredTaskHistoryAccessEvidenceProvider implements TaskHistoryAccessEvidenceProvider {
  resolve(): TaskHistoryAccessEvidenceResult {
    return { kind: 'unavailable' };
  }
}

@Injectable()
export class TaskHistoryAccessAuthorizationBoundary {
  constructor(
    @Inject(TASK_HISTORY_ACCESS_EVIDENCE_PROVIDER)
    private readonly evidenceProvider: TaskHistoryAccessEvidenceProvider,
  ) {}

  async authorize(requestValue: unknown): Promise<TaskHistoryAccessDecision> {
    const request = readExactRecord(requestValue, [
      'actorUserId',
      'organizationId',
      'projectId',
      'taskId',
    ]);
    if (
      !request ||
      !isObjectIdString(request.actorUserId) ||
      !isObjectIdString(request.organizationId) ||
      !isObjectIdString(request.projectId) ||
      !isObjectIdString(request.taskId)
    ) {
      return { kind: 'denied', reason: 'INVALID_REQUEST' };
    }

    let resultValue: TaskHistoryAccessEvidenceResult;
    try {
      resultValue = await this.evidenceProvider.resolve({
        actorUserId: request.actorUserId,
        organizationId: request.organizationId,
        projectId: request.projectId,
        taskId: request.taskId,
      });
    } catch {
      return { kind: 'denied', reason: 'EVIDENCE_UNAVAILABLE' };
    }

    const result = readExactRecord(resultValue, ['kind', 'evidence']);
    if (!result || result.kind !== 'resolved') {
      const deniedResult = readExactRecord(resultValue, ['kind']);
      if (deniedResult?.kind === 'denied') {
        return { kind: 'denied', reason: 'TASK_PERMISSION_DENIED' };
      }
      return { kind: 'denied', reason: 'EVIDENCE_UNAVAILABLE' };
    }

    const evidence = parseAccessEvidence(result.evidence);
    if (
      !evidence ||
      evidence.actorUserId !== request.actorUserId ||
      evidence.organizationId !== request.organizationId ||
      evidence.projectId !== request.projectId ||
      evidence.taskId !== request.taskId
    ) {
      return { kind: 'denied', reason: 'EVIDENCE_UNAVAILABLE' };
    }
    if (evidence.projectMembershipStatus !== 'ACTIVE') {
      return { kind: 'denied', reason: 'PROJECT_MEMBERSHIP_REQUIRED' };
    }
    if (!evidence.taskReadPermission) {
      return { kind: 'denied', reason: 'TASK_PERMISSION_DENIED' };
    }
    if (
      evidence.principalKind === 'SUCCESSOR' &&
      !evidence.validHandoverAssignment
    ) {
      return { kind: 'denied', reason: 'HANDOVER_ASSIGNMENT_REQUIRED' };
    }

    return { kind: 'allowed' };
  }
}

export interface TaskHistoryPageQuery {
  page: number;
  limit: number;
}

export interface TaskHistoryRepositoryPage {
  events: TaskEventDocument[];
  total: number;
}

export interface TaskHistoryQueryRepository {
  getById(projectId: string, taskId: string): Promise<TaskDocument | null>;
  listHistory(
    projectId: string,
    taskId: string,
    query: TaskHistoryPageQuery,
  ): Promise<TaskHistoryRepositoryPage>;
}

export interface TaskHistoryEventCommonV1 {
  schemaVersion: 1;
  id: string;
  taskId: string;
  projectId: string;
  actorId: string;
  actorType: 'USER' | 'SYSTEM';
  source: 'HUMAN' | 'WEB' | 'API' | 'INTERNAL_SERVICE';
  timestamp: string;
  version: number;
}

export type TaskHistoryEventV1 =
  | (TaskHistoryEventCommonV1 & {
      eventType: 'TASK_CREATED';
      changedFields: string[];
    })
  | (TaskHistoryEventCommonV1 & {
      eventType: 'TASK_STATUS_TRANSITIONED';
      changedFields: ['status'];
      delta: {
        type: 'STATUS_TRANSITION';
        fromStatus: TaskStatus;
        toStatus: TaskStatus;
      };
    });

export interface TaskHistoryPageV1 {
  schemaVersion: 1;
  data: TaskHistoryEventV1[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export type TaskHistoryQueryResult =
  | { kind: 'PAGE'; page: TaskHistoryPageV1 }
  | { kind: 'NOT_FOUND' }
  | { kind: 'INVALID_QUERY' }
  | { kind: 'INVALID_HISTORY_RECORD' };

interface ParsedTaskHistoryRequest {
  contextCandidate: unknown;
  requestBinding: unknown;
  projectId: string;
  taskId: string;
  page: number;
  limit: number;
}

function parseQueryRequest(value: unknown): ParsedTaskHistoryRequest | null {
  if (!isPlainObject(value)) return null;
  const allowedKeys = new Set([
    'contextCandidate',
    'requestBinding',
    'projectId',
    'taskId',
    'page',
    'limit',
  ]);
  try {
    if (
      Reflect.ownKeys(value).some(
        (key) => typeof key !== 'string' || !allowedKeys.has(key),
      )
    ) {
      return null;
    }
    const projectId = Object.getOwnPropertyDescriptor(value, 'projectId');
    const taskId = Object.getOwnPropertyDescriptor(value, 'taskId');
    const contextCandidate = Object.getOwnPropertyDescriptor(
      value,
      'contextCandidate',
    );
    const requestBinding = Object.getOwnPropertyDescriptor(
      value,
      'requestBinding',
    );
    const pageDescriptor = Object.getOwnPropertyDescriptor(value, 'page');
    const limitDescriptor = Object.getOwnPropertyDescriptor(value, 'limit');
    if (
      !projectId ||
      !('value' in projectId) ||
      !taskId ||
      !('value' in taskId) ||
      !contextCandidate ||
      !('value' in contextCandidate) ||
      !requestBinding ||
      !('value' in requestBinding)
    ) {
      return null;
    }
    for (const descriptor of [pageDescriptor, limitDescriptor]) {
      if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) {
        return null;
      }
    }
    const requestedPage: unknown =
      pageDescriptor?.value ?? DEFAULT_HISTORY_PAGE;
    const requestedLimit: unknown =
      limitDescriptor?.value ?? DEFAULT_HISTORY_LIMIT;
    if (
      typeof projectId.value !== 'string' ||
      typeof taskId.value !== 'string' ||
      !isObjectIdString(projectId.value) ||
      !isObjectIdString(taskId.value) ||
      typeof requestedPage !== 'number' ||
      !Number.isSafeInteger(requestedPage) ||
      requestedPage < 1 ||
      typeof requestedLimit !== 'number' ||
      !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > MAX_HISTORY_LIMIT
    ) {
      return null;
    }
    return {
      contextCandidate: contextCandidate.value,
      requestBinding: requestBinding.value,
      projectId: projectId.value,
      taskId: taskId.value,
      page: requestedPage,
      limit: requestedLimit,
    };
  } catch {
    return null;
  }
}

function toObjectIdHex(value: unknown): string | undefined {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { toHexString?: unknown }).toHexString !== 'function'
    ) {
      return undefined;
    }
    return (value as { toHexString(): string }).toHexString();
  } catch {
    return undefined;
  }
}

function toIsoString(value: unknown): string | undefined {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return undefined;
  return value.toISOString();
}

function isStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && taskStatusSet.has(value);
}

function isActorType(value: unknown): value is 'USER' | 'SYSTEM' {
  return value === 'USER' || value === 'SYSTEM';
}

function creationChangedFields(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter(
    (field): field is string =>
      typeof field === 'string' && creationFieldSet.has(field),
  );
  if (result.length !== TASK_CREATION_CHANGED_FIELDS.length) return undefined;
  if (new Set(result).size !== TASK_CREATION_CHANGED_FIELDS.length)
    return undefined;
  return result;
}

function mapCreationEvent(
  event: TaskCreationEventDocument,
): TaskHistoryEventV1 | undefined {
  const id = toObjectIdHex(event._id);
  const taskId = toObjectIdHex(event.taskId);
  const projectId = toObjectIdHex(event.projectId);
  const actorId = toObjectIdHex(event.actorId);
  const timestamp = toIsoString(event.occurredAt);
  const changedFields = creationChangedFields(event.changedFields);
  if (
    !id ||
    !taskId ||
    !projectId ||
    !actorId ||
    !timestamp ||
    event.eventName !== 'TASK_CREATED' ||
    event.actorType !== 'USER' ||
    !creationSources.has(event.source) ||
    event.taskVersion !== 1 ||
    !changedFields
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    id,
    taskId,
    projectId,
    eventType: 'TASK_CREATED',
    actorId,
    actorType: 'USER',
    source: 'HUMAN',
    timestamp,
    version: 1,
    changedFields,
  };
}

function mapTransitionEvent(
  event: TaskStatusTransitionEventDocument,
): TaskHistoryEventV1 | undefined {
  const id = toObjectIdHex(event._id);
  const taskId = toObjectIdHex(event.taskId);
  const projectId = toObjectIdHex(event.projectId);
  const actorId = toObjectIdHex(event.actorId);
  const timestamp = toIsoString(event.timestamp);
  const fromStatus = event.delta?.fromStatus;
  const toStatus = event.delta?.toStatus;
  if (
    !id ||
    !taskId ||
    !projectId ||
    !actorId ||
    !timestamp ||
    event.eventType !== 'TASK_STATUS_TRANSITIONED' ||
    !isActorType(event.actorType) ||
    !transitionSources.has(event.source) ||
    !Number.isSafeInteger(event.version) ||
    event.version < 2 ||
    !Array.isArray(event.changedFields) ||
    event.changedFields.length !== 1 ||
    event.changedFields[0] !== 'status' ||
    event.delta?.type !== 'STATUS_TRANSITION' ||
    !isStatus(fromStatus) ||
    !isStatus(toStatus)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    id,
    taskId,
    projectId,
    eventType: 'TASK_STATUS_TRANSITIONED',
    actorId,
    actorType: event.actorType,
    source: event.source,
    timestamp,
    version: event.version,
    changedFields: ['status'],
    delta: { type: 'STATUS_TRANSITION', fromStatus, toStatus },
  };
}

function mapHistoryEvent(
  event: TaskEventDocument,
): TaskHistoryEventV1 | undefined {
  if ('eventName' in event && event.eventName === 'TASK_CREATED')
    return mapCreationEvent(event as TaskCreationEventDocument);
  if ('eventType' in event && event.eventType === 'TASK_STATUS_TRANSITIONED')
    return mapTransitionEvent(event as TaskStatusTransitionEventDocument);
  return undefined;
}

@Injectable()
export class TaskHistoryQueryService {
  constructor(
    private readonly taskAuthorizationBoundary: TaskAuthorizationBoundary,
    private readonly historyAccessBoundary: TaskHistoryAccessAuthorizationBoundary,
    private readonly repository: TaskHistoryQueryRepository,
  ) {}

  async execute(requestValue: unknown): Promise<TaskHistoryQueryResult> {
    const request = parseQueryRequest(requestValue);
    if (!request) return { kind: 'INVALID_QUERY' };

    let authorization: TaskAuthorizationResult;
    try {
      authorization = await this.taskAuthorizationBoundary.authorize({
        operation: 'history',
        contextCandidate: request.contextCandidate,
        requestBinding: request.requestBinding,
        requestedProjectId: request.projectId,
        resourceId: request.taskId,
      });
    } catch {
      return { kind: 'NOT_FOUND' };
    }
    if (
      authorization.kind !== 'authorized' ||
      authorization.operation !== 'history' ||
      authorization.projectId !== request.projectId
    ) {
      return { kind: 'NOT_FOUND' };
    }

    const accessDecision = await this.historyAccessBoundary.authorize({
      actorUserId: authorization.actorUserId,
      organizationId: authorization.organizationId,
      projectId: authorization.projectId,
      taskId: request.taskId,
    });
    if (accessDecision.kind !== 'allowed') return { kind: 'NOT_FOUND' };

    const task = await this.repository.getById(
      request.projectId,
      request.taskId,
    );
    if (!task) return { kind: 'NOT_FOUND' };

    const page = await this.repository.listHistory(
      request.projectId,
      request.taskId,
      { page: request.page, limit: request.limit },
    );
    if (!Number.isSafeInteger(page.total) || page.total < 0)
      return { kind: 'INVALID_HISTORY_RECORD' };
    const data: TaskHistoryEventV1[] = [];
    for (const event of page.events) {
      const mapped = mapHistoryEvent(event);
      if (
        !mapped ||
        mapped.taskId !== request.taskId ||
        mapped.projectId !== request.projectId
      ) {
        return { kind: 'INVALID_HISTORY_RECORD' };
      }
      data.push(mapped);
    }
    return {
      kind: 'PAGE',
      page: {
        schemaVersion: 1,
        data,
        pagination: {
          page: request.page,
          limit: request.limit,
          total: page.total,
          totalPages: Math.ceil(page.total / request.limit),
        },
      },
    };
  }
}
