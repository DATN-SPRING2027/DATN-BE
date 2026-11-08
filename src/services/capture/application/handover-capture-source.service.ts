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
      const currentVersion = this.resolveWorkReportCurrentVersion(report);
      if (ref.version !== currentVersion) {
        return { ...unavailable(), exists: true, currentVersion };
      }
      return this.projectApprovedWorkReport(
        viewer,
        report,
        ref.id,
        currentVersion,
      );
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
      const sameAsLatestSnapshot =
        Number(latestHistDoc.contentSchemaVersion ?? 1) ===
          Number(note.contentSchemaVersion ?? 1) &&
        [
          'title',
          'contentMarkdown',
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
    if (excerpts.length === 0) {
      const markdown = asStr(sourceRecord.contentMarkdown).trim();
      if (markdown) {
        excerpts.push(
          ...this.chunkTextToExcerpts('SECTION', 'note-body', title, markdown),
        );
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
      const currentVersion = this.resolveWorkReportCurrentVersion(report);
      const reportId = String(report._id);
      if (currentVersion === null || !OBJECT_ID_RE.test(reportId)) continue;
      const evaluated = this.projectApprovedWorkReport(
        viewer,
        report,
        reportId,
        currentVersion,
      );
      if (evaluated.readable) {
        results.push(evaluated);
      }
      if (results.length >= limit) break;
    }

    return results;
  }

  async discoverDepartingMemberScopeSources(
    viewer: HandoverSourceViewer,
    departingUserId: string,
    taskIds: readonly string[] = [],
    limit = 50,
  ): Promise<
    Array<{
      evaluated: EvaluatedHandoverSource;
      isDepartingAuthor: boolean;
    }>
  > {
    if (!viewer.isProjectMember || !this.connection?.db) {
      return [];
    }
    const db = this.db();
    const orgObjId = new Types.ObjectId(viewer.organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(viewer.projectId.toLowerCase());
    const departingLower = OBJECT_ID_RE.test(departingUserId)
      ? departingUserId.toLowerCase()
      : '';
    const taskIdSet = new Set(
      taskIds
        .filter((id) => OBJECT_ID_RE.test(id))
        .map((id) => id.toLowerCase()),
    );

    const out: Array<{
      evaluated: EvaluatedHandoverSource;
      isDepartingAuthor: boolean;
    }> = [];

    // 1. TASK_NOTE (Confirmed notes in project, prioritizing departing member's notes & task notes)
    const notes = await db
      .collection('work_notes')
      .find({
        organizationId: orgObjId,
        projectId: projectObjId,
        status: 'CONFIRMED',
        deletedAt: { $in: [null, undefined] },
      })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .toArray();

    for (const note of notes) {
      const noteId = String(note._id).toLowerCase();
      if (!OBJECT_ID_RE.test(noteId)) continue;
      const authorHex =
        note.authorUserId instanceof Types.ObjectId
          ? note.authorUserId.toHexString().toLowerCase()
          : typeof note.authorUserId === 'string'
            ? note.authorUserId.toLowerCase()
            : '';
      const taskHex =
        note.taskId instanceof Types.ObjectId
          ? note.taskId.toHexString().toLowerCase()
          : typeof note.taskId === 'string'
            ? note.taskId.toLowerCase()
            : '';
      const isDepartingRelated =
        !departingLower ||
        authorHex === departingLower ||
        taskIdSet.has(taskHex);
      if (!isDepartingRelated) continue;

      const versions = await db
        .collection('work_note_versions')
        .find({ workNoteId: new Types.ObjectId(noteId) })
        .project({ versionNumber: 1 })
        .toArray();
      let maxHistVer = 0;
      for (const v of versions) {
        if (
          typeof v.versionNumber === 'number' &&
          v.versionNumber > maxHistVer
        ) {
          maxHistVer = v.versionNumber;
        }
      }
      const candidateVer = maxHistVer >= 1 ? maxHistVer : 1;
      const evaluated = await this.evaluateSource(viewer, {
        kind: 'TASK_NOTE',
        id: noteId,
        version: candidateVer,
      });
      if (evaluated.eligible && evaluated.readable && evaluated.isCurrent) {
        out.push({
          evaluated,
          isDepartingAuthor: Boolean(
            departingLower && authorHex === departingLower,
          ),
        });
      }
      if (out.length >= limit) return out;
    }

    // 2. PROJECT_DOCUMENT (Approved project documents)
    const docs = await db
      .collection('project_documents')
      .find({
        organizationId: orgObjId,
        projectId: projectObjId,
      })
      .sort({ updatedAt: -1, _id: -1 })
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
      const docId = String(doc._id).toLowerCase();
      if (!OBJECT_ID_RE.test(docId)) continue;
      const evaluated = await this.evaluateSource(viewer, {
        kind: 'PROJECT_DOCUMENT',
        id: docId,
        version: doc.latestApprovedVersionNumber,
      });
      if (evaluated.eligible && evaluated.readable && evaluated.isCurrent) {
        const createdByHex =
          doc.createdBy instanceof Types.ObjectId
            ? doc.createdBy.toHexString().toLowerCase()
            : typeof doc.createdBy === 'string'
              ? doc.createdBy.toLowerCase()
              : '';
        out.push({
          evaluated,
          isDepartingAuthor: Boolean(
            departingLower && createdByHex === departingLower,
          ),
        });
      }
      if (out.length >= limit) return out;
    }

    // 3. WORK_REPORT (Approved work reports of departing member)
    const reports = await db
      .collection('work_reports')
      .find({
        organizationId: orgObjId,
        projectId: projectObjId,
        status: 'APPROVED',
      })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .toArray();

    for (const report of reports) {
      const reportId = String(report._id).toLowerCase();
      const currentVersion = this.resolveWorkReportCurrentVersion(report);
      if (currentVersion === null || !OBJECT_ID_RE.test(reportId)) continue;
      const memberHex =
        report.memberUserId instanceof Types.ObjectId
          ? report.memberUserId.toHexString().toLowerCase()
          : typeof report.memberUserId === 'string'
            ? report.memberUserId.toLowerCase()
            : '';
      if (departingLower && memberHex && memberHex !== departingLower) {
        continue;
      }
      const evaluated = this.projectApprovedWorkReport(
        viewer,
        report,
        reportId,
        currentVersion,
      );
      if (evaluated.eligible && evaluated.readable && evaluated.isCurrent) {
        out.push({
          evaluated,
          isDepartingAuthor: Boolean(
            !departingLower || memberHex === departingLower,
          ),
        });
      }
      if (out.length >= limit) break;
    }

    return out;
  }

  async countDepartingMemberCaptureSourcesByProjects(
    organizationId: string,
    projectIds: readonly string[],
    departingUserId: string,
  ): Promise<
    Map<
      string,
      {
        taskNoteCount: number;
        documentCount: number;
        workReportCount: number;
      }
    >
  > {
    const out = new Map<
      string,
      {
        taskNoteCount: number;
        documentCount: number;
        workReportCount: number;
      }
    >();
    const validProjectIds = projectIds
      .map((p) => p.toLowerCase())
      .filter((p) => OBJECT_ID_RE.test(p));
    for (const pid of validProjectIds) {
      out.set(pid, {
        taskNoteCount: 0,
        documentCount: 0,
        workReportCount: 0,
      });
    }
    if (
      validProjectIds.length === 0 ||
      !OBJECT_ID_RE.test(organizationId) ||
      !OBJECT_ID_RE.test(departingUserId) ||
      !this.connection?.db
    ) {
      return out;
    }

    const db = this.db();
    const orgObjId = new Types.ObjectId(organizationId.toLowerCase());
    const projObjIds = validProjectIds.map((p) => new Types.ObjectId(p));
    const departingObjId = new Types.ObjectId(departingUserId.toLowerCase());

    const [notes, docs, reports] = await Promise.all([
      db
        .collection('work_notes')
        .find({
          organizationId: orgObjId,
          projectId: { $in: projObjIds },
          authorUserId: departingObjId,
          status: 'CONFIRMED',
          deletedAt: { $in: [null, undefined] },
        })
        .project({ projectId: 1 })
        .toArray(),
      db
        .collection('project_documents')
        .find({
          organizationId: orgObjId,
          projectId: { $in: projObjIds },
          status: { $ne: 'ARCHIVED' },
          latestApprovedVersionNumber: { $gte: 1 },
        })
        .project({ projectId: 1 })
        .toArray(),
      db
        .collection('work_reports')
        .find({
          organizationId: orgObjId,
          projectId: { $in: projObjIds },
          memberUserId: departingObjId,
          status: 'APPROVED',
        })
        .project({ projectId: 1 })
        .toArray(),
    ]);

    for (const row of notes) {
      if (row.projectId instanceof Types.ObjectId) {
        const pid = row.projectId.toHexString().toLowerCase();
        const cur = out.get(pid);
        if (cur) cur.taskNoteCount += 1;
      }
    }
    for (const row of docs) {
      if (row.projectId instanceof Types.ObjectId) {
        const pid = row.projectId.toHexString().toLowerCase();
        const cur = out.get(pid);
        if (cur) cur.documentCount += 1;
      }
    }
    for (const row of reports) {
      if (row.projectId instanceof Types.ObjectId) {
        const pid = row.projectId.toHexString().toLowerCase();
        const cur = out.get(pid);
        if (cur) cur.workReportCount += 1;
      }
    }

    return out;
  }

  private resolveWorkReportCurrentVersion(
    report: Record<string, unknown>,
  ): number | null {
    const history = Array.isArray(report.reviewHistory)
      ? report.reviewHistory
      : [];
    const approvals = history.filter(
      (h: Record<string, unknown>) =>
        h?.action === 'APPROVED' || h?.status === 'APPROVED',
    ).length;
    const legacyVersion = Math.max(1, approvals);
    if (
      report.contentSchemaVersion === undefined &&
      report.currentVersionNumber === undefined
    ) {
      return legacyVersion;
    }

    // Capture writes canonical content and version together. Editor history can
    // include drafts saved after this approved row was read.
    const version = report.currentVersionNumber;
    if (
      report.contentSchemaVersion !== 2 ||
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      // A lower editor version could already identify a prior approval.
      version < legacyVersion ||
      typeof report.contentMarkdown !== 'string' ||
      !report.contentMarkdown.trim()
    ) {
      return null;
    }
    return version;
  }

  private projectApprovedWorkReport(
    viewer: HandoverSourceViewer,
    report: Record<string, unknown>,
    id: string,
    version: number,
  ): EvaluatedHandoverSource {
    const memberUserId = report.memberUserId;
    const authorId =
      memberUserId instanceof Types.ObjectId
        ? memberUserId.toHexString()
        : typeof memberUserId === 'string'
          ? memberUserId.toLowerCase()
          : '';
    const isAuthor = authorId === viewer.userId.toLowerCase();
    const readable =
      isAuthor || (report.reportScope !== 'LEADER' && viewer.isProjectLeader);
    const source: EvaluatedHandoverSource = {
      kind: 'WORK_REPORT',
      id: id.toLowerCase(),
      version,
      exists: true,
      eligible: true,
      readable,
      isCurrent: true,
      currentVersion: version,
      title: '',
      excerpts: [],
    };
    if (!readable) return source;

    const period =
      report.periodStart instanceof Date
        ? report.periodStart.toISOString().slice(0, 10)
        : 'period';
    const title = typeof report.title === 'string' ? report.title.trim() : '';
    source.title = (title || `Work Report (${period})`).slice(0, 255);
    for (const [key, heading] of [
      ['accomplishments', 'Accomplishments'],
      ['approach', 'Approach'],
      ['reason', 'Decision Rationale'],
      ['blockers', 'Blockers'],
      ['nextSteps', 'Next Steps'],
    ] as const) {
      const content = typeof report[key] === 'string' ? report[key].trim() : '';
      if (content) {
        source.excerpts.push({
          locatorKind: 'SECTION',
          locatorValue: key,
          heading,
          content: content.slice(0, 15000),
        });
      }
    }
    if (
      source.excerpts.length === 0 &&
      typeof report.contentMarkdown === 'string'
    ) {
      source.excerpts = this.chunkTextToExcerpts(
        'SECTION',
        'report-body',
        source.title,
        report.contentMarkdown.trim(),
      );
    }
    return source;
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
