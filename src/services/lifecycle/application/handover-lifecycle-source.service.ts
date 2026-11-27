import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { SERVICE_DATABASES } from '../../../common/mongodb/database-names';
import type {
  EvaluatedHandoverSource,
  HandoverSourceExcerpt,
  HandoverSourceViewer,
} from '../../capture/application/handover-capture-source.service';
import { LIFECYCLE_PERSISTENCE } from '../infrastructure/persistence';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export type LifecycleSourceViewer = HandoverSourceViewer & {
  teamIds?: readonly string[];
};

interface KnowledgeObjectRecord {
  _id: Types.ObjectId | string;
  organizationId?: Types.ObjectId | string;
  projectId?: Types.ObjectId | string;
  teamId?: Types.ObjectId | string | null;
  title?: string;
  status?: string;
  currentVersionNumber?: number;
  ownerUserId?: string | Types.ObjectId | null;
  smeUserId?: string | Types.ObjectId | null;
  confidentiality?: string;
  allowedUserIds?: unknown;
  aclUserIds?: unknown;
  authorizedUserIds?: unknown;
}

interface KnowledgeVersionRecord {
  knowledgeObjectId: Types.ObjectId | string;
  versionNumber: number;
  title?: string;
  contentMarkdown?: string;
  summary?: string;
}

function normalizeId(value: unknown): string {
  if (value instanceof Types.ObjectId) return value.toHexString().toLowerCase();
  if (typeof value === 'string') return value.trim().toLowerCase();
  return '';
}

function extractExplicitAclIds(ko: KnowledgeObjectRecord): Set<string> {
  const ids = new Set<string>();
  for (const field of [
    ko.allowedUserIds,
    ko.aclUserIds,
    ko.authorizedUserIds,
  ]) {
    if (!Array.isArray(field)) continue;
    for (const entry of field) {
      const normalized = normalizeId(entry);
      if (normalized) ids.add(normalized);
    }
  }
  return ids;
}

@Injectable()
export class HandoverLifecycleSourceService {
  constructor(
    @Optional()
    @InjectConnection(LIFECYCLE_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @InjectConnection(SERVICE_DATABASES.iam)
    private readonly iamConnection?: Connection,
  ) {}

  private db() {
    if (!this.connection?.db) {
      throw new ServiceUnavailableException({
        code: 'LIFECYCLE_DATABASE_UNAVAILABLE',
        message: 'Lifecycle persistence is unavailable.',
      });
    }
    return this.connection.db;
  }

  private getIamDb() {
    if (this.iamConnection?.db) {
      return this.iamConnection.db;
    }
    if (typeof this.connection?.useDb === 'function') {
      const switched = this.connection.useDb(SERVICE_DATABASES.iam, {
        useCache: true,
      });
      if (switched?.db) {
        return switched.db;
      }
    }
    return null;
  }

  private buildUnavailable(ref: {
    id: string;
    version: number;
  }): EvaluatedHandoverSource {
    return {
      kind: 'KNOWLEDGE_OBJECT',
      id: ref.id.toLowerCase(),
      version: ref.version,
      exists: false,
      eligible: false,
      readable: false,
      isCurrent: false,
      currentVersion: null,
      title: '',
      excerpts: [],
    };
  }

  private async hasActiveTeamMembership(
    orgObjId: Types.ObjectId,
    viewer: LifecycleSourceViewer,
    teamIdHex: string,
  ): Promise<boolean> {
    if (Array.isArray(viewer.teamIds)) {
      return viewer.teamIds.some(
        (id) => normalizeId(id) === teamIdHex.toLowerCase(),
      );
    }
    if (!OBJECT_ID_RE.test(teamIdHex)) {
      return false;
    }
    const iamDb = this.getIamDb();
    if (!iamDb) {
      return false;
    }
    const actorLower = viewer.userId.trim().toLowerCase();
    const userCandidates: Array<string | Types.ObjectId> = OBJECT_ID_RE.test(
      actorLower,
    )
      ? [actorLower, new Types.ObjectId(actorLower)]
      : [actorLower];
    const membership = await iamDb.collection('team_memberships').findOne({
      organizationId: orgObjId,
      teamId: new Types.ObjectId(teamIdHex),
      userId: { $in: userCandidates },
      status: 'ACTIVE',
    });
    return Boolean(membership);
  }

  private async loadTeamMembershipsBatch(
    orgObjId: Types.ObjectId,
    viewers: readonly LifecycleSourceViewer[],
    teamIds: readonly string[],
  ): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    const viewersToQuery: LifecycleSourceViewer[] = [];
    for (const viewer of viewers) {
      const actorLower = viewer.userId.trim().toLowerCase();
      if (Array.isArray(viewer.teamIds)) {
        map.set(
          actorLower,
          new Set(viewer.teamIds.map((id) => normalizeId(id)).filter(Boolean)),
        );
      } else {
        viewersToQuery.push(viewer);
      }
    }

    const validTeamIds = [
      ...new Set(teamIds.map((id) => id.toLowerCase())),
    ].filter((id) => OBJECT_ID_RE.test(id));
    if (viewersToQuery.length === 0 || validTeamIds.length === 0) {
      return map;
    }

    const iamDb = this.getIamDb();
    if (!iamDb) {
      return map;
    }

    const userCandidates: Array<string | Types.ObjectId> = [];
    const seenUsers = new Set<string>();
    for (const viewer of viewersToQuery) {
      const actorLower = viewer.userId.trim().toLowerCase();
      if (seenUsers.has(actorLower)) continue;
      seenUsers.add(actorLower);
      userCandidates.push(actorLower);
      if (OBJECT_ID_RE.test(actorLower)) {
        userCandidates.push(new Types.ObjectId(actorLower));
      }
    }

    const coll = iamDb.collection('team_memberships');
    const cursor = coll.find({
      organizationId: orgObjId,
      teamId: { $in: validTeamIds.map((id) => new Types.ObjectId(id)) },
      userId: { $in: userCandidates },
      status: 'ACTIVE',
    });
    const rows =
      typeof cursor?.toArray === 'function' ? await cursor.toArray() : [];
    for (const row of rows as Array<{ userId?: unknown; teamId?: unknown }>) {
      const uid = normalizeId(row.userId);
      const tid = normalizeId(row.teamId);
      if (!uid || !tid) continue;
      let set = map.get(uid);
      if (!set) {
        set = new Set<string>();
        map.set(uid, set);
      }
      set.add(tid);
    }
    return map;
  }

  private evaluateLoadedObject(
    viewer: LifecycleSourceViewer,
    ref: { kind: 'KNOWLEDGE_OBJECT'; id: string; version: number },
    ko: KnowledgeObjectRecord | undefined,
    verDoc: KnowledgeVersionRecord | undefined,
    hasTeamAccess: boolean,
  ): EvaluatedHandoverSource {
    if (
      !ko ||
      ko.status !== 'VERIFIED' ||
      typeof ko.currentVersionNumber !== 'number' ||
      ko.currentVersionNumber < 1
    ) {
      return this.buildUnavailable(ref);
    }

    if (!verDoc) {
      return {
        ...this.buildUnavailable(ref),
        exists: true,
        currentVersion: ko.currentVersionNumber,
      };
    }

    const actorIdLower = viewer.userId.trim().toLowerCase();
    const ownerIdLower = normalizeId(ko.ownerUserId);
    const smeIdLower = normalizeId(ko.smeUserId);
    const explicitAcl = extractExplicitAclIds(ko);
    const teamIdHex = normalizeId(ko.teamId);
    const teamSatisfied = !teamIdHex || hasTeamAccess;

    let canRead = false;
    if (!viewer.isProjectMember) {
      canRead = false;
    } else if (ko.confidentiality === 'RESTRICTED') {
      // SEC-AUTH-014: Never grant blanket isProjectLeader bypass on RESTRICTED objects.
      const explicitlyAuthorized =
        ownerIdLower === actorIdLower ||
        (smeIdLower !== '' && smeIdLower === actorIdLower) ||
        explicitAcl.has(actorIdLower);
      canRead = explicitlyAuthorized && teamSatisfied;
    } else if (ko.confidentiality === 'TEAM') {
      canRead = Types.ObjectId.isValid(teamIdHex) && hasTeamAccess;
    } else if (
      ko.confidentiality === 'PROJECT' ||
      ko.confidentiality === 'INTERNAL' ||
      ko.confidentiality === 'PUBLIC'
    ) {
      canRead = teamSatisfied;
    } else {
      canRead = false;
    }

    if (!canRead) {
      return {
        kind: 'KNOWLEDGE_OBJECT',
        id: ref.id.toLowerCase(),
        version: ref.version,
        exists: true,
        eligible: true,
        readable: false,
        isCurrent: ref.version === ko.currentVersionNumber,
        currentVersion: ko.currentVersionNumber,
        title: '',
        excerpts: [],
      };
    }

    const title = String(verDoc.title || ko.title || 'Knowledge Object').slice(
      0,
      255,
    );
    const md = String(verDoc.contentMarkdown || verDoc.summary || title).trim();
    const excerpts: HandoverSourceExcerpt[] = md
      ? [
          {
            locatorKind: 'SECTION',
            locatorValue: 'content-markdown',
            heading: title,
            content: md.slice(0, 15000),
          },
        ]
      : [];

    return {
      kind: 'KNOWLEDGE_OBJECT',
      id: ref.id.toLowerCase(),
      version: ref.version,
      exists: true,
      eligible: true,
      readable: true,
      isCurrent: ref.version === ko.currentVersionNumber,
      currentVersion: ko.currentVersionNumber,
      title,
      logicalSourceId: `knowledge-object:${ref.id.toLowerCase()}`,
      excerpts,
    };
  }

  async evaluateSource(
    viewer: LifecycleSourceViewer,
    ref: { kind: 'KNOWLEDGE_OBJECT'; id: string; version: number },
  ): Promise<EvaluatedHandoverSource> {
    if (
      !OBJECT_ID_RE.test(ref.id) ||
      !Number.isSafeInteger(ref.version) ||
      ref.version < 1 ||
      !viewer.isProjectMember
    ) {
      return this.buildUnavailable(ref);
    }

    const db = this.db();
    const orgObjId = new Types.ObjectId(viewer.organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(viewer.projectId.toLowerCase());
    const koObjId = new Types.ObjectId(ref.id.toLowerCase());

    const ko = (await db.collection('knowledge_objects').findOne({
      _id: koObjId,
      organizationId: orgObjId,
      projectId: projectObjId,
    })) as KnowledgeObjectRecord | null;
    if (
      !ko ||
      ko.status !== 'VERIFIED' ||
      typeof ko.currentVersionNumber !== 'number' ||
      ko.currentVersionNumber < 1
    ) {
      return this.buildUnavailable(ref);
    }

    const verDoc = (await db.collection('knowledge_versions').findOne({
      organizationId: orgObjId,
      projectId: projectObjId,
      knowledgeObjectId: koObjId,
      versionNumber: ref.version,
    })) as KnowledgeVersionRecord | null;
    if (!verDoc) {
      return {
        ...this.buildUnavailable(ref),
        exists: true,
        currentVersion: ko.currentVersionNumber,
      };
    }

    const teamIdHex = normalizeId(ko.teamId);
    const hasTeamAccess = teamIdHex
      ? await this.hasActiveTeamMembership(orgObjId, viewer, teamIdHex)
      : true;

    return this.evaluateLoadedObject(viewer, ref, ko, verDoc, hasTeamAccess);
  }

  async evaluateSourcesBatch(
    viewer: LifecycleSourceViewer,
    refs: ReadonlyArray<{
      kind: 'KNOWLEDGE_OBJECT';
      id: string;
      version: number;
    }>,
  ): Promise<EvaluatedHandoverSource[]> {
    const [results] = await this.evaluateSourcesBatchForViewers([viewer], refs);
    return results ?? [];
  }

  async evaluateSourcesBatchForViewers(
    viewers: readonly LifecycleSourceViewer[],
    refs: ReadonlyArray<{
      kind: 'KNOWLEDGE_OBJECT';
      id: string;
      version: number;
    }>,
  ): Promise<EvaluatedHandoverSource[][]> {
    if (viewers.length === 0) return [];
    if (refs.length === 0) return viewers.map(() => []);

    const results: EvaluatedHandoverSource[][] = viewers.map(() =>
      refs.map((ref) => this.buildUnavailable(ref)),
    );

    const validRefIndices: number[] = [];
    const uniqueKoHexIds = new Set<string>();
    const uniqueVersionNumbers = new Set<number>();
    for (let i = 0; i < refs.length; i += 1) {
      const ref = refs[i];
      if (
        OBJECT_ID_RE.test(ref.id) &&
        Number.isSafeInteger(ref.version) &&
        ref.version >= 1
      ) {
        validRefIndices.push(i);
        uniqueKoHexIds.add(ref.id.toLowerCase());
        uniqueVersionNumbers.add(ref.version);
      }
    }

    if (validRefIndices.length === 0) {
      return results;
    }

    const groups = new Map<
      string,
      {
        orgId: string;
        projectId: string;
        entries: Array<{ viewerIndex: number; viewer: LifecycleSourceViewer }>;
      }
    >();
    for (let vIdx = 0; vIdx < viewers.length; vIdx += 1) {
      const viewer = viewers[vIdx];
      if (!viewer.isProjectMember) continue;
      const orgId = viewer.organizationId.toLowerCase();
      const projectId = viewer.projectId.toLowerCase();
      const groupKey = `${orgId}:${projectId}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { orgId, projectId, entries: [] };
        groups.set(groupKey, group);
      }
      group.entries.push({ viewerIndex: vIdx, viewer });
    }

    if (groups.size === 0) {
      return results;
    }

    const db = this.db();
    const koObjIds = [...uniqueKoHexIds].map((id) => new Types.ObjectId(id));
    const versionNums = [...uniqueVersionNumbers];

    for (const group of groups.values()) {
      const orgObjId = new Types.ObjectId(group.orgId);
      const projectObjId = new Types.ObjectId(group.projectId);

      const koCursor = db.collection('knowledge_objects').find({
        _id: { $in: koObjIds },
        organizationId: orgObjId,
        projectId: projectObjId,
        status: 'VERIFIED',
        currentVersionNumber: { $gte: 1 },
      });

      if (typeof koCursor?.toArray !== 'function') {
        // Fallback for minimal unit-test collection mocks that only stub findOne.
        for (const { viewerIndex, viewer } of group.entries) {
          for (const refIndex of validRefIndices) {
            results[viewerIndex][refIndex] = await this.evaluateSource(
              viewer,
              refs[refIndex],
            );
          }
        }
        continue;
      }

      const koRows = (await koCursor.toArray()) as KnowledgeObjectRecord[];
      const koById = new Map<string, KnowledgeObjectRecord>();
      const verifiedKoObjIds: Types.ObjectId[] = [];
      const referencedTeamIds = new Set<string>();

      for (const row of koRows) {
        const idHex = normalizeId(row._id);
        if (!idHex) continue;
        koById.set(idHex, row);
        verifiedKoObjIds.push(new Types.ObjectId(idHex));
        const teamIdHex = normalizeId(row.teamId);
        if (teamIdHex) referencedTeamIds.add(teamIdHex);
      }

      const verByKey = new Map<string, KnowledgeVersionRecord>();
      if (verifiedKoObjIds.length > 0) {
        const verCursor = db.collection('knowledge_versions').find({
          organizationId: orgObjId,
          projectId: projectObjId,
          knowledgeObjectId: { $in: verifiedKoObjIds },
          versionNumber: { $in: versionNums },
        });
        const verRows =
          typeof verCursor?.toArray === 'function'
            ? ((await verCursor.toArray()) as unknown as KnowledgeVersionRecord[])
            : [];
        for (const row of verRows) {
          const idHex = normalizeId(row.knowledgeObjectId);
          if (!idHex || typeof row.versionNumber !== 'number') continue;
          verByKey.set(`${idHex}:${row.versionNumber}`, row);
        }
      }

      const teamMap =
        referencedTeamIds.size > 0
          ? await this.loadTeamMembershipsBatch(
              orgObjId,
              group.entries.map((e) => e.viewer),
              [...referencedTeamIds],
            )
          : new Map<string, Set<string>>();

      for (const { viewerIndex, viewer } of group.entries) {
        const actorTeams = teamMap.get(viewer.userId.trim().toLowerCase());
        for (const refIndex of validRefIndices) {
          const ref = refs[refIndex];
          const idHex = ref.id.toLowerCase();
          const ko = koById.get(idHex);
          const verDoc = ko
            ? verByKey.get(`${idHex}:${ref.version}`)
            : undefined;
          const teamIdHex = ko ? normalizeId(ko.teamId) : '';
          const hasTeamAccess = !teamIdHex
            ? true
            : Boolean(actorTeams?.has(teamIdHex));
          results[viewerIndex][refIndex] = this.evaluateLoadedObject(
            viewer,
            ref,
            ko,
            verDoc,
            hasTeamAccess,
          );
        }
      }
    }

    return results;
  }

  async discoverCandidateSources(
    viewer: LifecycleSourceViewer,
    _departingUserId: string,
    _query: string,
    limit = 20,
  ): Promise<EvaluatedHandoverSource[]> {
    if (!viewer.isProjectMember) return [];
    const db = this.db();
    const orgObjId = new Types.ObjectId(viewer.organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(viewer.projectId.toLowerCase());

    const rows = (await db
      .collection('knowledge_objects')
      .find({
        organizationId: orgObjId,
        projectId: projectObjId,
        status: 'VERIFIED',
        currentVersionNumber: { $gte: 1 },
      })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray()) as KnowledgeObjectRecord[];

    const candidateRefs: Array<{
      kind: 'KNOWLEDGE_OBJECT';
      id: string;
      version: number;
    }> = [];
    for (const row of rows) {
      if (
        row.status !== 'VERIFIED' ||
        typeof row.currentVersionNumber !== 'number' ||
        row.currentVersionNumber < 1
      ) {
        continue;
      }
      candidateRefs.push({
        kind: 'KNOWLEDGE_OBJECT',
        id: normalizeId(row._id),
        version: row.currentVersionNumber,
      });
    }

    if (candidateRefs.length === 0) return [];
    const evaluated = await this.evaluateSourcesBatch(viewer, candidateRefs);
    return evaluated.filter((item) => item.eligible && item.readable);
  }
}
