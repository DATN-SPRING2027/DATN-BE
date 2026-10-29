import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import type {
  EvaluatedHandoverSource,
  HandoverSourceExcerpt,
  HandoverSourceViewer,
} from '../../capture/application/handover-capture-source.service';
import { LIFECYCLE_PERSISTENCE } from '../infrastructure/persistence';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

@Injectable()
export class HandoverLifecycleSourceService {
  constructor(
    @Optional()
    @InjectConnection(LIFECYCLE_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
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

  async evaluateSource(
    viewer: HandoverSourceViewer,
    ref: { kind: 'KNOWLEDGE_OBJECT'; id: string; version: number },
  ): Promise<EvaluatedHandoverSource> {
    const unavailable = (): EvaluatedHandoverSource => ({
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
    });

    if (
      !OBJECT_ID_RE.test(ref.id) ||
      !Number.isSafeInteger(ref.version) ||
      ref.version < 1 ||
      !viewer.isProjectMember
    ) {
      return unavailable();
    }

    const db = this.db();
    const orgObjId = new Types.ObjectId(viewer.organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(viewer.projectId.toLowerCase());
    const koObjId = new Types.ObjectId(ref.id.toLowerCase());

    const ko = await db.collection('knowledge_objects').findOne({
      _id: koObjId,
      organizationId: orgObjId,
      projectId: projectObjId,
    });
    if (
      !ko ||
      ko.status !== 'VERIFIED' ||
      typeof ko.currentVersionNumber !== 'number' ||
      ko.currentVersionNumber < 1
    ) {
      return unavailable();
    }

    const verDoc = await db.collection('knowledge_versions').findOne({
      organizationId: orgObjId,
      projectId: projectObjId,
      knowledgeObjectId: koObjId,
      versionNumber: ref.version,
    });
    if (!verDoc) {
      return {
        ...unavailable(),
        exists: true,
        currentVersion: ko.currentVersionNumber,
      };
    }

    const actorIdLower = viewer.userId.toLowerCase();
    const ownerIdLower = String(ko.ownerUserId ?? '').toLowerCase();
    const smeIdLower = String(ko.smeUserId ?? '').toLowerCase();
    const restricted = ko.confidentiality === 'RESTRICTED';
    const canRead = !restricted
      ? viewer.isProjectMember
      : viewer.isProjectLeader ||
        ownerIdLower === actorIdLower ||
        (smeIdLower !== '' && smeIdLower === actorIdLower);

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

  async discoverCandidateSources(
    viewer: HandoverSourceViewer,
    _departingUserId: string,
    _query: string,
    limit = 20,
  ): Promise<EvaluatedHandoverSource[]> {
    if (!viewer.isProjectMember) return [];
    const db = this.db();
    const orgObjId = new Types.ObjectId(viewer.organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(viewer.projectId.toLowerCase());

    const rows = await db
      .collection('knowledge_objects')
      .find({
        organizationId: orgObjId,
        projectId: projectObjId,
      })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();

    const results: EvaluatedHandoverSource[] = [];
    for (const row of rows) {
      if (
        row.status !== 'VERIFIED' ||
        typeof row.currentVersionNumber !== 'number' ||
        row.currentVersionNumber < 1
      ) {
        continue;
      }
      const evaluated = await this.evaluateSource(viewer, {
        kind: 'KNOWLEDGE_OBJECT',
        id: String(row._id),
        version: row.currentVersionNumber,
      });
      if (evaluated.eligible && evaluated.readable) {
        results.push(evaluated);
      }
    }
    return results;
  }
}
