import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { CAPTURE_PERSISTENCE } from '../infrastructure/persistence';

export type CaptureSourceKind =
  'TASK_NOTE' | 'PROJECT_DOCUMENT' | 'WORK_REPORT';

export interface HandoverSourceViewer {
  organizationId: string;
  projectId: string;
  userId: string;
  isProjectMember: boolean;
  isProjectLeader: boolean;
}

export interface HandoverSourceExcerpt {
  locatorKind: 'CHUNK' | 'PAGE' | 'LINE' | 'SECTION';
  locatorValue: string;
  heading: string;
  content: string;
}

export interface EvaluatedHandoverSource {
  kind: CaptureSourceKind | 'KNOWLEDGE_OBJECT';
  id: string;
  version: number;
  exists: boolean;
  eligible: boolean;
  readable: boolean;
  isCurrent: boolean;
  currentVersion: number | null;
  title: string;
  logicalSourceId?: string;
  excerpts: HandoverSourceExcerpt[];
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

@Injectable()
export class HandoverCaptureSourceService {
  constructor(
    @Optional()
    @InjectConnection(CAPTURE_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  private db() {
    if (!this.connection?.db) {
      throw new ServiceUnavailableException({
        code: 'CAPTURE_DATABASE_UNAVAILABLE',
        message: 'Capture persistence is unavailable.',
      });
    }
    return this.connection.db;
  }

  async evaluateSource(
    viewer: HandoverSourceViewer,
    ref: { kind: CaptureSourceKind; id: string; version: number },
  ): Promise<EvaluatedHandoverSource> {
    const unavailable = (): EvaluatedHandoverSource => ({
      kind: ref.kind,
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
      ref.version < 1
    ) {
      return unavailable();
    }
    if (!viewer.isProjectMember) {
      return unavailable();
    }

    const db = this.db();
    const orgObjId = new Types.ObjectId(viewer.organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(viewer.projectId.toLowerCase());
    const idObj = new Types.ObjectId(ref.id.toLowerCase());

    if (ref.kind === 'PROJECT_DOCUMENT') {
      const doc = await db.collection('project_documents').findOne({
        _id: idObj,
        organizationId: orgObjId,
        projectId: projectObjId,
      });
      if (
        !doc ||
        doc.status === 'ARCHIVED' ||
        typeof doc.latestApprovedVersionNumber !== 'number' ||
        doc.latestApprovedVersionNumber < 1
      ) {
        return unavailable();
      }
      const verDoc = await db.collection('project_document_versions').findOne({
        documentId: idObj,
        organizationId: orgObjId,
        projectId: projectObjId,
        versionNumber: ref.version,
      });
      if (!verDoc || verDoc.status !== 'APPROVED') {
        return {
          ...unavailable(),
          exists: true,
          currentVersion: doc.latestApprovedVersionNumber,
        };
      }
      const title = String(
        verDoc.title || doc.title || 'Project Document',
      ).slice(0, 255);
      const rawContent = String(
        verDoc.content || verDoc.description || title,
      ).trim();
      const excerpts = this.chunkTextToExcerpts(
        'SECTION',
        'doc-body',
        title,
        rawContent,
      );
      return {
        kind: 'PROJECT_DOCUMENT',
        id: ref.id.toLowerCase(),
        version: ref.version,
        exists: true,
        eligible: true,
        readable: true,
        isCurrent: doc.latestApprovedVersionNumber === ref.version,
        currentVersion: doc.latestApprovedVersionNumber,
        title,
        logicalSourceId: `project-document:${ref.id.toLowerCase()}`,
        excerpts,
      };
    }

    if (ref.kind === 'WORK_REPORT') {
      const report = await db.collection('work_reports').findOne({
        _id: idObj,
        organizationId: orgObjId,
        projectId: projectObjId,
      });
      if (!report || report.status !== 'APPROVED') {
        return unavailable();
      }
      const history = Array.isArray(report.reviewHistory)
        ? report.reviewHistory
        : [];
      const approvals = history.filter(
        (h: Record<string, unknown>) =>
          h?.action === 'APPROVED' || h?.status === 'APPROVED',
      ).length;
      const currentVersion = Math.max(1, approvals);
      // work_reports does not store historical text snapshots across re-approvals;
      // only the current approved version has verifiable content matching ref.version.
      if (ref.version !== currentVersion) {
        return { ...unavailable(), exists: true, currentVersion };
      }

      const authorId = String(report.memberUserId ?? '').toLowerCase();
      const scope = report.reportScope === 'LEADER' ? 'LEADER' : 'MEMBER';
      const isAuthor = authorId === viewer.userId.toLowerCase();
      const canReadReport =
        scope === 'LEADER' ? isAuthor : isAuthor || viewer.isProjectLeader;

      if (!canReadReport) {
        return {
          kind: 'WORK_REPORT',
          id: ref.id.toLowerCase(),
          version: ref.version,
          exists: true,
          eligible: true,
          readable: false,
          isCurrent: ref.version === currentVersion,
          currentVersion,
          title: '',
          excerpts: [],
        };
      }

      const periodStr =
        report.periodStart instanceof Date
          ? report.periodStart.toISOString().slice(0, 10)
          : 'period';
      const title = `Work Report (${periodStr})`.slice(0, 255);
      const excerpts: HandoverSourceExcerpt[] = [];
      for (const [key, label] of [
        ['accomplishments', 'Accomplishments'],
        ['approach', 'Approach'],
        ['reason', 'Decision Rationale'],
        ['blockers', 'Blockers'],
        ['nextSteps', 'Next Steps'],
      ] as const) {
        const val = typeof report[key] === 'string' ? report[key].trim() : '';
        if (val) {
          excerpts.push({
            locatorKind: 'SECTION',
            locatorValue: key,
            heading: label,
            content: val.slice(0, 15000),
          });
        }
      }
      return {
        kind: 'WORK_REPORT',
        id: ref.id.toLowerCase(),
        version: ref.version,
        exists: true,
        eligible: true,
        readable: true,
        isCurrent: ref.version === currentVersion,
        currentVersion,
        title,
        excerpts,
      };
    }

    // TASK_NOTE
    const note = await db.collection('work_notes').findOne({
      _id: idObj,
      organizationId: orgObjId,
      projectId: projectObjId,
    });
    if (!note || note.status !== 'CONFIRMED' || note.deletedAt) {
      return unavailable();
    }
    const versions = await db
      .collection('work_note_versions')
      .find({ workNoteId: idObj })
      .toArray();
    const asStr = (val: unknown): string =>
      typeof val === 'string' ? val : '';
    let maxHistVer = 0;
    let latestHistDoc: Record<string, unknown> | null = null;
    for (const row of versions) {
      if (
        typeof row.versionNumber === 'number' &&
        row.versionNumber > maxHistVer
      ) {
        maxHistVer = row.versionNumber;
        latestHistDoc = row;
      }
    }

    // An in-place edit has no durable version identity. Never invent max+1:
    // multiple edits could otherwise serve different text under the same pin.
    let currentVersion: number | null = null;
    let liveNoteRepresentsCurrentVersion = false;
    if (latestHistDoc && maxHistVer >= 1) {
      const sameAsLatestSnapshot = [
        'title',
        'whatDone',
        'howSolved',
        'whyThisWay',
        'blocker',
        'unfinished',
        'nextStep',
      ].every((key) => asStr(latestHistDoc[key]) === asStr(note[key]));
      if (sameAsLatestSnapshot) {
        currentVersion = maxHistVer;
      }
    } else {
      // Confirmation can occur again after edits; it is not a version counter.
      const baseDate = note.createdAt instanceof Date ? note.createdAt : null;
      const updatedDate =
        note.updatedAt instanceof Date ? note.updatedAt : null;
      if (
        baseDate &&
        updatedDate &&
        updatedDate.getTime() <= baseDate.getTime()
      ) {
        currentVersion = 1;
        liveNoteRepresentsCurrentVersion = true;
      }
    }

    if (currentVersion !== null && ref.version > currentVersion) {
      return { ...unavailable(), exists: true, currentVersion };
    }

    const matchingSnapshot = versions.find(
      (row) => row.versionNumber === ref.version,
    );

    let sourceRecord: Record<string, unknown> | null = null;
    if (matchingSnapshot) {
      sourceRecord = matchingSnapshot;
    } else if (
      ref.version === currentVersion &&
      liveNoteRepresentsCurrentVersion
    ) {
      sourceRecord = note;
    }

    if (!sourceRecord) {
      return { ...unavailable(), exists: true, currentVersion };
    }

    const title = (asStr(sourceRecord.title) || 'Task Note').slice(0, 255);
    const excerpts: HandoverSourceExcerpt[] = [];
    for (const [key, label] of [
      ['whatDone', 'What Was Done'],
      ['howSolved', 'How Solved'],
      ['whyThisWay', 'Why Decided This Way'],
      ['blocker', 'Blocker'],
      ['unfinished', 'Unfinished Work'],
      ['nextStep', 'Next Step'],
    ] as const) {
      const val = asStr(sourceRecord[key]).trim();
      if (val) {
        excerpts.push({
          locatorKind: 'SECTION',
          locatorValue: key,
          heading: label,
          content: val.slice(0, 15000),
        });
      }
    }
    return {
      kind: 'TASK_NOTE',
      id: ref.id.toLowerCase(),
      version: ref.version,
      exists: true,
      eligible: true,
      readable: true,
      isCurrent: ref.version === currentVersion,
      currentVersion,
      title,
      excerpts,
    };
  }

  async discoverCandidateSources(
    viewer: HandoverSourceViewer,
    departingUserId: string,
    _query: string,
    limit = 30,
  ): Promise<EvaluatedHandoverSource[]> {
    if (!viewer.isProjectMember) return [];
    const db = this.db();
    const orgObjId = new Types.ObjectId(viewer.organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(viewer.projectId.toLowerCase());
    const departingObjId = OBJECT_ID_RE.test(departingUserId)
      ? new Types.ObjectId(departingUserId.toLowerCase())
      : null;

    const results: EvaluatedHandoverSource[] = [];
    const docs = await db
      .collection('project_documents')
      .find({
        organizationId: orgObjId,
        projectId: projectObjId,
      })
      .limit(limit)
      .toArray();

    for (const doc of docs) {
      if (
        doc.status === 'ARCHIVED' ||
        typeof doc.latestApprovedVersionNumber !== 'number' ||
        doc.latestApprovedVersionNumber < 1
      ) {
        continue;
      }
      const evaluated = await this.evaluateSource(viewer, {
        kind: 'PROJECT_DOCUMENT',
        id: String(doc._id),
        version: doc.latestApprovedVersionNumber,
      });
      if (evaluated.eligible && evaluated.readable) {
        results.push(evaluated);
      }
      if (results.length >= limit) return results;
    }

    const reports = await db
      .collection('work_reports')
      .find({
        organizationId: orgObjId,
        projectId: projectObjId,
        ...(departingObjId ? { memberUserId: departingObjId } : {}),
      })
      .limit(limit)
      .toArray();

    for (const report of reports) {
      if (report.status !== 'APPROVED') continue;
      const history = Array.isArray(report.reviewHistory)
        ? report.reviewHistory
        : [];
      const currentVersion = Math.max(
        1,
        history.filter(
          (h: Record<string, unknown>) =>
            h?.action === 'APPROVED' || h?.status === 'APPROVED',
        ).length,
      );
      const evaluated = await this.evaluateSource(viewer, {
        kind: 'WORK_REPORT',
        id: String(report._id),
        version: currentVersion,
      });
      if (evaluated.eligible && evaluated.readable) {
        results.push(evaluated);
      }
      if (results.length >= limit) break;
    }

    return results;
  }

  private chunkTextToExcerpts(
    locatorKind: 'SECTION',
    prefix: string,
    heading: string,
    text: string,
  ): HandoverSourceExcerpt[] {
    if (!text) return [];
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (paragraphs.length <= 1) {
      return [
        {
          locatorKind,
          locatorValue: `${prefix}-1`,
          heading,
          content: text.slice(0, 15000),
        },
      ];
    }
    return paragraphs.slice(0, 10).map((para, idx) => ({
      locatorKind,
      locatorValue: `${prefix}-${idx + 1}`,
      heading,
      content: para.slice(0, 8000),
    }));
  }
}
