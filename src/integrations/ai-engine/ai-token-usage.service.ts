import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { CAPTURE_PERSISTENCE } from '../../services/capture/infrastructure/persistence';
import { IAM_PERSISTENCE } from '../../services/iam/infrastructure/persistence';
import {
  AuthenticationApplicationService,
  type AuthenticatedIdentity,
} from '../../services/iam/application/authentication/authentication.application.service';
import { HandoverIamScopeService } from '../../services/iam/application/projects/handover-iam-scope.service';
import type { ProjectRecord } from '../../services/iam/application/projects/project.repository';
import { ProjectService } from '../../services/iam/application/projects/project.service';
import type { AiChatRequestHeaders } from './ai-chat.types';
import {
  AI_TOKEN_USAGE_TASK_KINDS,
  type AiTokenUsageBucketRow,
  type AiTokenUsageOwnerDto,
  type AiTokenUsageOwnerKind,
  type AiTokenUsageProjectOptionDto,
  type AiTokenUsageResponseDto,
  type AiTokenUsageScope,
  type AiTokenUsageTaskKind,
  type AiTokenUsageTaskMetaDto,
  type RecordAiTokenUsageEventInput,
} from './ai-token-usage.types';

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const HOUR_MS = 3_600_000;
const LOOKBACK_DAYS = 400; // Covers 53-week heatmap + 12 months chart
export const AI_TOKEN_USAGE_LOGS_COLLECTION = 'ai_token_usage_logs';

const TASK_INDEX_MAP: Readonly<Record<AiTokenUsageTaskKind, number>> = {
  ai_chat: 0,
  mind_map: 1,
  knowledge_sync: 2,
  note_assessment: 3,
  note_rewrite: 4,
};

const TASK_META_LIST: readonly AiTokenUsageTaskMetaDto[] =
  AI_TOKEN_USAGE_TASK_KINDS.map((id, index) => ({ id, index }));

interface RawTokenSample {
  readonly timestampMs: number;
  readonly projectId: string;
  readonly userId: string;
  readonly taskKind: AiTokenUsageTaskKind;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly calls: number;
}

function toSafeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value);
}

function toTimestampMs(value: unknown): number | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

function idString(value: unknown): string {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (value instanceof Types.ObjectId) return value.toHexString().toLowerCase();
  if (
    value &&
    typeof value === 'object' &&
    'toHexString' in value &&
    typeof value.toHexString === 'function'
  ) {
    return String(
      (value as { toHexString: () => string }).toHexString(),
    ).toLowerCase();
  }
  return '';
}

@Injectable()
export class AiTokenUsageService {
  private indexesEnsured = false;
  private readonly projectsCache = new Map<
    string,
    { expiresAt: number; data: ProjectRecord[] }
  >();

  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly projects: ProjectService,
    @Optional() private readonly iamScope?: HandoverIamScopeService,
    @Optional()
    @InjectConnection(CAPTURE_PERSISTENCE.databaseName)
    private readonly captureConnection?: Connection,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly iamConnection?: Connection,
  ) {}

  private ensureCollectionIndexes(): void {
    if (this.indexesEnsured) return;
    const db = this.captureConnection?.db;
    if (!db) return;
    this.indexesEnsured = true;
    const col = db.collection(AI_TOKEN_USAGE_LOGS_COLLECTION);
    if (typeof col.createIndex === 'function') {
      void col
        .createIndex(
          { organizationId: 1, occurredAt: -1, projectId: 1, userId: 1 },
          { background: true },
        )
        .catch(() => undefined);
      void col
        .createIndex(
          { organizationId: 1, projectId: 1, dedupeKey: 1 },
          { background: true, sparse: true },
        )
        .catch(() => undefined);
    }
  }

  async recordUsageEvent(input: RecordAiTokenUsageEventInput): Promise<void> {
    const db = this.captureConnection?.db;
    if (!db) return;
    if (
      !OBJECT_ID_PATTERN.test(input.organizationId) ||
      !OBJECT_ID_PATTERN.test(input.projectId) ||
      !OBJECT_ID_PATTERN.test(input.userId)
    ) {
      return;
    }
    const inputTokens = toSafeNonNegativeInt(input.inputTokens);
    const cacheReadTokens = toSafeNonNegativeInt(input.cacheReadTokens);
    const cacheWriteTokens = toSafeNonNegativeInt(input.cacheWriteTokens);
    const outputTokens = toSafeNonNegativeInt(input.outputTokens);
    const total =
      inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
    if (total <= 0) return;

    this.ensureCollectionIndexes();

    try {
      const dedupeKey =
        typeof input.dedupeKey === 'string' && input.dedupeKey.trim()
          ? input.dedupeKey.trim().slice(0, 180)
          : undefined;
      const doc = {
        organizationId: new Types.ObjectId(input.organizationId.toLowerCase()),
        projectId: new Types.ObjectId(input.projectId.toLowerCase()),
        userId: new Types.ObjectId(input.userId.toLowerCase()),
        taskKind: input.taskKind,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        calls: Math.max(1, toSafeNonNegativeInt(input.calls ?? 1)),
        ...(dedupeKey ? { dedupeKey } : {}),
        occurredAt: input.occurredAt ?? new Date(),
      };
      const col = db.collection(AI_TOKEN_USAGE_LOGS_COLLECTION);
      if (dedupeKey && typeof col.updateOne === 'function') {
        await col.updateOne(
          {
            organizationId: doc.organizationId,
            projectId: doc.projectId,
            dedupeKey,
          },
          { $setOnInsert: doc },
          { upsert: true },
        );
      } else {
        await col.insertOne(doc);
      }
    } catch {
      // Telemetry recording must never fail user-facing AI operations.
    }
  }

  private async listVisibleActiveProjects(
    actor: AuthenticatedIdentity,
  ): Promise<ProjectRecord[]> {
    const cacheKey = `${actor.organizationId.toLowerCase()}:${actor.id.toLowerCase()}`;
    const now = Date.now();
    const cached = this.projectsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const pageSize = 100;
    const deduped = new Map<string, ProjectRecord>();
    const collect = (items: readonly ProjectRecord[]) => {
      for (const item of items) {
        if (item.status === 'ACTIVE' && OBJECT_ID_PATTERN.test(item.id)) {
          deduped.set(item.id.toLowerCase(), item);
        }
      }
    };
    const first = await this.projects.list(actor, {
      page: 1,
      pageSize,
      status: 'ACTIVE',
    });
    collect(first.data);
    const totalPages = Math.min(first.pagination.totalPages ?? 1, 5);
    if (totalPages > 1) {
      const restPages = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) =>
          this.projects.list(actor, {
            page: i + 2,
            pageSize,
            status: 'ACTIVE',
          }),
        ),
      );
      for (const pageResult of restPages) {
        collect(pageResult.data);
      }
    }
    const result = [...deduped.values()];
    this.projectsCache.set(cacheKey, {
      expiresAt: now + 30_000,
      data: result,
    });
    return result;
  }

  /**
   * Synchronous check using the `leaders` array already populated on `ProjectRecord`
   * by `ProjectService.list` / `ProjectService.get`, avoiding N+1 IAM DB round-trips.
   */
  private isActorLeaderOfProjectSync(
    actor: AuthenticatedIdentity,
    project: ProjectRecord,
  ): boolean {
    if (Array.isArray(actor.roles) && actor.roles.includes('ADMIN')) {
      return true;
    }
    const actorIdLower = actor.id.toLowerCase();
    return (
      Array.isArray(project.leaders) &&
      project.leaders.some((l) => l.userId.toLowerCase() === actorIdLower)
    );
  }

  private async loadProjectMemberDirectory(
    organizationId: string,
    project: ProjectRecord,
  ): Promise<Map<string, AiTokenUsageOwnerDto>> {
    const members = new Map<string, AiTokenUsageOwnerDto>();
    const addMember = (
      userId: string,
      name: string,
      roleLabel?: string,
      avatarUrl?: string | null,
    ) => {
      const key = userId.trim().toLowerCase();
      if (!OBJECT_ID_PATTERN.test(key)) return;
      const existing = members.get(key);
      if (existing) {
        if (!existing.subtitle && roleLabel) {
          members.set(key, { ...existing, subtitle: roleLabel });
        }
        return;
      }
      members.set(key, {
        id: key,
        name: name.trim() || 'Thành viên dự án',
        ...(roleLabel ? { subtitle: roleLabel } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        kind: 'member',
      });
    };

    for (const leader of project.leaders ?? []) {
      addMember(leader.userId, leader.fullName, 'Team Leader');
    }
    for (const preview of project.memberPreviews ?? []) {
      addMember(
        preview.userId,
        preview.fullName,
        preview.roleCode === 'TEAM_LEADER' ? 'Team Leader' : 'Member',
      );
    }

    const iamDb = this.iamConnection?.db;
    if (iamDb && OBJECT_ID_PATTERN.test(organizationId)) {
      try {
        const orgObjId = new Types.ObjectId(organizationId.toLowerCase());
        const projObjId = new Types.ObjectId(project.id.toLowerCase());
        const [memberships, leaderAssignments] = await Promise.all([
          iamDb
            .collection('project_memberships')
            .find(
              {
                organizationId: orgObjId,
                projectId: projObjId,
                status: 'ACTIVE',
              },
              { projection: { userId: 1 } },
            )
            .toArray(),
          iamDb
            .collection('role_assignments')
            .find(
              {
                organizationId: orgObjId,
                projectId: projObjId,
                roleCode: 'TEAM_LEADER',
              },
              { projection: { userId: 1 } },
            )
            .toArray(),
        ]);
        const leaderIds = new Set(
          leaderAssignments.map((item) => idString(item.userId)),
        );
        const userObjIds = memberships
          .map((m) => m.userId as unknown)
          .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId);
        if (userObjIds.length > 0) {
          const users = await iamDb
            .collection('users')
            .find(
              { _id: { $in: userObjIds } },
              { projection: { _id: 1, fullName: 1, email: 1, avatarUrl: 1 } },
            )
            .toArray();
          for (const u of users) {
            const uid = idString(u._id);
            const fullName =
              typeof u.fullName === 'string' && u.fullName.trim()
                ? u.fullName.trim()
                : typeof u.email === 'string'
                  ? u.email
                  : 'Thành viên';
            const avatarUrl =
              typeof u.avatarUrl === 'string' ? u.avatarUrl : null;
            addMember(
              uid,
              fullName,
              leaderIds.has(uid) ? 'Team Leader' : 'Member',
              avatarUrl,
            );
          }
        }
      } catch {
        // Fallback to project leader/member previews if IAM query fails
      }
    }

    return members;
  }

  async getTokenUsage(
    headers: AiChatRequestHeaders,
    query: {
      scope?: string;
      projectId?: string;
    } = {},
  ): Promise<AiTokenUsageResponseDto> {
    const rawScope = query.scope?.trim().toLowerCase();
    if (
      rawScope !== undefined &&
      rawScope !== '' &&
      rawScope !== 'personal' &&
      rawScope !== 'project' &&
      rawScope !== 'organization'
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'scope must be one of: personal, project, organization.',
      });
    }

    const rawProjectId = query.projectId?.trim().toLowerCase();
    if (
      rawProjectId &&
      rawProjectId !== 'all' &&
      !OBJECT_ID_PATTERN.test(rawProjectId)
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'projectId must be a 24-character hex identifier.',
      });
    }

    const actor = await this.auth.getCurrentIdentity(
      headers.authorization,
      headers.cookie,
    );

    const requestedOrgId = headers.organizationId?.trim();
    if (
      requestedOrgId &&
      requestedOrgId.toLowerCase() !== actor.organizationId.toLowerCase()
    ) {
      throw new ForbiddenException({
        code: 'ORGANIZATION_SCOPE_MISMATCH',
        message: 'Organization scope does not match the authenticated user.',
      });
    }

    const isOrgManager =
      Array.isArray(actor.roles) && actor.roles.includes('ADMIN');

    // Run project listing and token usage log fetch IN PARALLEL to minimize latency
    const [visibleProjects, rawOrgSamples] = await Promise.all([
      this.listVisibleActiveProjects(actor),
      this.fetchExplicitUsageLogs({
        organizationId: actor.organizationId.toLowerCase(),
        // When pure MEMBER or explicit 'personal' scope, filter by userId right at the DB index level
        restrictToUserId:
          rawScope === 'personal' ? actor.id.toLowerCase() : null,
      }),
    ]);

    const projectOptions: AiTokenUsageProjectOptionDto[] = visibleProjects.map(
      (proj) => ({
        id: proj.id.toLowerCase(),
        name: proj.name,
        code: proj.code,
        isLeader: this.isActorLeaderOfProjectSync(actor, proj),
      }),
    );

    const projectById = new Map(
      projectOptions.map((item) => [item.id, item] as const),
    );
    const recordById = new Map(
      visibleProjects.map((item) => [item.id.toLowerCase(), item] as const),
    );

    let validatedProjectId: string | null = null;
    if (rawProjectId && rawProjectId !== 'all') {
      if (!projectById.has(rawProjectId)) {
        const fetched = await this.projects.get(actor, rawProjectId);
        if (fetched.status !== 'ACTIVE') {
          throw new NotFoundException({
            code: 'PROJECT_NOT_FOUND',
            message: 'Project not found.',
          });
        }
        const opt: AiTokenUsageProjectOptionDto = {
          id: fetched.id.toLowerCase(),
          name: fetched.name,
          code: fetched.code,
          isLeader: this.isActorLeaderOfProjectSync(actor, fetched),
        };
        projectOptions.push(opt);
        projectById.set(opt.id, opt);
        recordById.set(opt.id, fetched);
      }
      validatedProjectId = rawProjectId;
    }

    const hasAnyLedProject = projectOptions.some((p) => p.isLeader);
    const highestRole: 'ADMIN' | 'TEAM_LEADER' | 'MEMBER' = isOrgManager
      ? 'ADMIN'
      : hasAnyLedProject
        ? 'TEAM_LEADER'
        : 'MEMBER';

    const availableScopes: AiTokenUsageScope[] = ['personal'];
    if (hasAnyLedProject || isOrgManager) {
      availableScopes.unshift('project');
    }
    if (isOrgManager) {
      availableScopes.unshift('organization');
    }

    // Strict RBAC scope resolution:
    // 1. Pure MEMBER (not ADMIN and not Leader of selected project) is ALWAYS locked to 'personal' scope.
    // 2. TEAM_LEADER can use 'project' scope ONLY on projects where isLeader === true; otherwise falls back to 'personal'.
    // 3. ADMIN can use 'organization', 'project', or 'personal'.
    let effectiveScope: AiTokenUsageScope = 'personal';
    let selectedProjectId: string | null = validatedProjectId;

    if (rawScope === 'organization' && isOrgManager) {
      effectiveScope = 'organization';
      selectedProjectId = null;
    } else if (rawScope === 'project') {
      const candidateProject = validatedProjectId
        ? projectById.get(validatedProjectId)
        : projectOptions.find((p) => p.isLeader);
      if (candidateProject && (candidateProject.isLeader || isOrgManager)) {
        effectiveScope = 'project';
        selectedProjectId = candidateProject.id;
      } else {
        effectiveScope = 'personal';
      }
    } else if (rawScope === 'personal') {
      effectiveScope = 'personal';
    } else {
      if (validatedProjectId) {
        const projOpt = projectById.get(validatedProjectId);
        if (projOpt && (projOpt.isLeader || isOrgManager)) {
          effectiveScope = 'project';
          selectedProjectId = projOpt.id;
        } else {
          effectiveScope = 'personal';
          selectedProjectId = validatedProjectId;
        }
      } else if (isOrgManager) {
        effectiveScope = 'organization';
      } else {
        effectiveScope = 'personal';
      }
    }

    const ownerGroupKind: AiTokenUsageOwnerKind =
      effectiveScope === 'project' ? 'member' : 'project';

    let owners: AiTokenUsageOwnerDto[] = [];
    const ownerIndexById = new Map<string, number>();

    if (effectiveScope === 'project' && selectedProjectId) {
      const projRecord = recordById.get(selectedProjectId);
      const memberMap = projRecord
        ? await this.loadProjectMemberDirectory(
            actor.organizationId,
            projRecord,
          )
        : new Map<string, AiTokenUsageOwnerDto>();

      const actorIdLower = actor.id.toLowerCase();
      if (!memberMap.has(actorIdLower)) {
        memberMap.set(actorIdLower, {
          id: actorIdLower,
          name: actor.name || 'Bạn',
          subtitle: isOrgManager ? 'Manager' : 'Team Leader',
          kind: 'member',
        });
      }
      owners = [...memberMap.values()];
      owners.forEach((owner, idx) => ownerIndexById.set(owner.id, idx));
    } else {
      owners = projectOptions.map((proj) => ({
        id: proj.id,
        name: proj.name,
        code: proj.code,
        subtitle: proj.code,
        kind: 'project',
      }));
      owners.forEach((owner, idx) => ownerIndexById.set(owner.id, idx));
    }

    const allowedProjectSet = new Set(
      effectiveScope === 'project' && selectedProjectId
        ? [selectedProjectId]
        : projectOptions.map((p) => p.id),
    );

    // CRITICAL RBAC: In 'personal' scope (including all MEMBER requests), strictly filter by actor.id!
    const restrictToUserId =
      effectiveScope === 'personal' ? actor.id.toLowerCase() : null;

    // Aggregate into compact hourly buckets: [hourEpoch, ownerIdx, taskIdx, input, cacheRead, cacheWrite, output, calls]
    const bucketMap = new Map<
      string,
      [number, number, number, number, number, number, number, number]
    >();

    for (const sample of rawOrgSamples) {
      if (!allowedProjectSet.has(sample.projectId.toLowerCase())) {
        continue;
      }
      if (
        restrictToUserId !== null &&
        sample.userId.toLowerCase() !== restrictToUserId
      ) {
        continue;
      }

      const ownerKey =
        ownerGroupKind === 'member'
          ? sample.userId.toLowerCase()
          : sample.projectId.toLowerCase();

      let ownerIdx = ownerIndexById.get(ownerKey);
      if (ownerIdx === undefined) {
        if (ownerGroupKind === 'member' && OBJECT_ID_PATTERN.test(ownerKey)) {
          ownerIdx = owners.length;
          owners.push({
            id: ownerKey,
            name: `Thành viên (${ownerKey.slice(-4)})`,
            subtitle: 'Member',
            kind: 'member',
          });
          ownerIndexById.set(ownerKey, ownerIdx);
        } else {
          continue;
        }
      }

      const taskIdx = TASK_INDEX_MAP[sample.taskKind];
      if (taskIdx === undefined) continue;

      const hourEpoch = Math.floor(sample.timestampMs / HOUR_MS);
      const mapKey = `${hourEpoch}:${ownerIdx}:${taskIdx}`;
      const existing = bucketMap.get(mapKey);
      if (existing) {
        existing[3] += sample.inputTokens;
        existing[4] += sample.cacheReadTokens;
        existing[5] += sample.cacheWriteTokens;
        existing[6] += sample.outputTokens;
        existing[7] += sample.calls;
      } else {
        bucketMap.set(mapKey, [
          hourEpoch,
          ownerIdx,
          taskIdx,
          sample.inputTokens,
          sample.cacheReadTokens,
          sample.cacheWriteTokens,
          sample.outputTokens,
          sample.calls,
        ]);
      }
    }

    const rows: AiTokenUsageBucketRow[] = [...bucketMap.values()].sort(
      (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2],
    );

    return {
      effectiveScope,
      availableScopes,
      ownerGroupKind,
      selectedProjectId,
      actor: {
        id: actor.id.toLowerCase(),
        name: actor.name,
        role: highestRole,
      },
      projects: projectOptions,
      owners,
      tasks: TASK_META_LIST,
      rows,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Queries ONLY the dedicated `ai_token_usage_logs` collection using its compound index.
   * Never scans or fabricates heuristic tokens from unrelated document/note collections.
   */
  private async fetchExplicitUsageLogs(params: {
    organizationId: string;
    restrictToUserId: string | null;
  }): Promise<RawTokenSample[]> {
    const db = this.captureConnection?.db;
    if (!db || !OBJECT_ID_PATTERN.test(params.organizationId)) {
      return [];
    }

    this.ensureCollectionIndexes();

    const orgObjId = new Types.ObjectId(params.organizationId);
    const userObjId =
      params.restrictToUserId && OBJECT_ID_PATTERN.test(params.restrictToUserId)
        ? new Types.ObjectId(params.restrictToUserId)
        : null;
    const sinceDate = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
    const samples: RawTokenSample[] = [];

    try {
      const explicitLogs = await db
        .collection(AI_TOKEN_USAGE_LOGS_COLLECTION)
        .find({
          organizationId: orgObjId,
          ...(userObjId ? { userId: userObjId } : {}),
          occurredAt: { $gte: sinceDate },
        })
        .project({
          projectId: 1,
          userId: 1,
          taskKind: 1,
          inputTokens: 1,
          cacheReadTokens: 1,
          cacheWriteTokens: 1,
          outputTokens: 1,
          calls: 1,
          dedupeKey: 1,
          occurredAt: 1,
        })
        .toArray();

      const seenDedupeKeys = new Set<string>();

      for (const row of explicitLogs) {
        const dedupeKey =
          typeof row.dedupeKey === 'string' && row.dedupeKey.trim()
            ? row.dedupeKey.trim()
            : '';
        if (dedupeKey) {
          if (seenDedupeKeys.has(dedupeKey)) continue;
          seenDedupeKeys.add(dedupeKey);
        }
        const taskKind = row.taskKind as AiTokenUsageTaskKind;
        if (!(taskKind in TASK_INDEX_MAP)) continue;
        const ts = toTimestampMs(row.occurredAt);
        const projId = idString(row.projectId);
        const uid = idString(row.userId);
        if (!ts || !projId || !uid) continue;
        samples.push({
          timestampMs: ts,
          projectId: projId,
          userId: uid,
          taskKind,
          inputTokens: toSafeNonNegativeInt(row.inputTokens),
          cacheReadTokens: toSafeNonNegativeInt(row.cacheReadTokens),
          cacheWriteTokens: toSafeNonNegativeInt(row.cacheWriteTokens),
          outputTokens: toSafeNonNegativeInt(row.outputTokens),
          calls: Math.max(1, toSafeNonNegativeInt(row.calls ?? 1)),
        });
      }
    } catch {
      // Return empty if query fails
    }

    return samples;
  }
}
