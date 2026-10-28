import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  WorkNoteEditorService,
  type EditorWorkflow,
  type CreateEditorInput,
} from '../application/work-note-agent/work-note-editor.service';
import {
  objectId,
  uuidInput,
  positive,
  parseDraftInput,
} from '../application/work-note-agent/work-note-agent-drafts.validation';
import type { AgentDraftView } from '../application/work-note-agent/work-note-agent-drafts.types';
import type { DocumentType } from '../application/work-notes.types';
import { captureDraftHeaders } from './work-note-editor.http';
const bad = () =>
  new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
const types = [
  'MVP',
  'DATABASE_DESIGN',
  'RSR',
  'ARCHITECTURE',
  'API_SPECIFICATION',
  'RESEARCH',
  'REQUIREMENT',
  'DESIGN',
  'TECHNICAL_SPECIFICATION',
  'OTHER',
];
function record(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw bad();
  return value as Record<string, unknown>;
}
function workflow(value: unknown): EditorWorkflow {
  if (value !== 'PROJECT_DOCUMENT' && value !== 'WORK_REPORT') throw bad();
  return value;
}
function source(value: unknown) {
  const v = record(value, ['workflow', 'resourceId', 'documentType']);
  const w = workflow(v.workflow);
  const id = v.resourceId === undefined ? undefined : objectId(v.resourceId);
  if (w === 'WORK_REPORT' && (!id || v.documentType !== undefined)) throw bad();
  if (
    w === 'PROJECT_DOCUMENT' &&
    (id
      ? v.documentType !== undefined
      : typeof v.documentType !== 'string' || !types.includes(v.documentType))
  )
    throw bad();
  return {
    workflow: w,
    resourceId: id,
    documentType: v.documentType as DocumentType | undefined,
  };
}
function editorView(d: AgentDraftView, projectId: string) {
  return {
    id: d.id,
    workflow: d.workflow,
    resourceId: d.resourceId ?? null,
    baseVersion: d.baseNoteVersion,
    baseContentHash: d.baseContentHash,
    revision: d.revision,
    title: d.title,
    contentMarkdown: d.contentMarkdown,
    expiresAt: d.expiresAt,
    conversation: d.conversation,
    pendingQuestion: d.pendingQuestion,
    suggestion: d.suggestion,
    hasAppliedRewrite: d.hasAppliedRewrite,
    context: { ...d.context, projectId },
  };
}
@Controller('capture/projects/:projectId/editor-drafts')
export class WorkNoteEditorController {
  constructor(private readonly editor: WorkNoteEditorService) {}
  @Put('sources/WORK_REPORT/:resourceId/document-links')
  links(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('resourceId') id: string,
    @Body() body: unknown,
  ) {
    const v = record(body, ['documentIds']);
    if (
      !Array.isArray(v.documentIds) ||
      v.documentIds.some((x) => typeof x !== 'string')
    )
      throw bad();
    return this.editor.updateReportLinks(
      captureDraftHeaders(req, true),
      objectId(p),
      objectId(id),
      v.documentIds as string[],
    );
  }
  @Post() create(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Body() body: unknown,
  ) {
    const headers = captureDraftHeaders(req, true),
      project = objectId(p),
      v = record(body, [
        'operationId',
        'workflow',
        'documentId',
        'documentType',
        'reportId',
      ]);
    const w = workflow(v.workflow),
      operationId = uuidInput(v.operationId);
    let input: CreateEditorInput;
    if (w === 'PROJECT_DOCUMENT') {
      if (
        v.reportId !== undefined ||
        (v.documentId !== undefined && v.documentType !== undefined) ||
        (!v.documentId &&
          (typeof v.documentType !== 'string' ||
            !types.includes(v.documentType)))
      )
        throw bad();
      input = {
        operationId,
        workflow: w,
        ...(v.documentId
          ? { documentId: objectId(v.documentId) }
          : { documentType: v.documentType as DocumentType }),
      };
    } else {
      if (v.documentId !== undefined || v.documentType !== undefined)
        throw bad();
      input = { operationId, workflow: w, reportId: objectId(v.reportId) };
    }
    return this.editor
      .createEditor(headers, project, input)
      .then((d) => editorView(d, project));
  }
  @Get() async resume(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Query() query: unknown,
    @Res() res: Response,
  ) {
    const headers = captureDraftHeaders(req),
      project = objectId(p),
      s = source(query);
    const d = await this.editor.resumeEditor(
      headers,
      project,
      s.workflow,
      s.resourceId,
      s.documentType,
    );
    res.status(200).json(d ? editorView(d, project) : null);
  }
  @Get(':draftId') async get(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') id: string,
  ) {
    const d = await this.editor.get(
      captureDraftHeaders(req),
      objectId(p),
      uuidInput(id),
    );
    return editorView(d, p);
  }
  @Patch(':draftId') async update(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    const d = await this.editor.update(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(id),
      parseDraftInput('update', body),
    );
    return editorView(d, p);
  }
  @Delete(':draftId') @HttpCode(204) discard(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    const v = parseDraftInput('discard', body);
    return this.editor.discard(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(id),
      v.expectedRevision,
    );
  }
  @Post(':draftId/reset-chat') @HttpCode(200) async reset(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    const d = await this.editor.reset(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(id),
      parseDraftInput('reset', body),
    );
    return editorView(d, p);
  }
  @Post(':draftId/agent/messages') @HttpCode(200) message(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    return this.editor.message(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(id),
      parseDraftInput('message', body),
    );
  }
  @Post(':draftId/agent/suggestions/:suggestionId/apply')
  @HttpCode(200)
  async apply(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') id: string,
    @Param('suggestionId') s: string,
    @Body() body: unknown,
  ) {
    const d = await this.editor.apply(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(id),
      uuidInput(s),
      parseDraftInput('apply', body),
    );
    return editorView(d, p);
  }
  @Post(':draftId/save') @HttpCode(200) save(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    return this.editor.saveEditor(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(id),
      parseDraftInput('save', body),
    );
  }
  @Get('sources/:workflow/:resourceId/versions') versions(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('workflow') w: string,
    @Param('resourceId') id: string,
    @Query() query: unknown,
  ) {
    const q = record(query, ['page', 'pageSize']);
    return this.editor.editorVersions(
      captureDraftHeaders(req),
      objectId(p),
      workflow(w),
      objectId(id),
      positive(Number(q.page ?? 1)),
      positive(Number(q.pageSize ?? 20), 50),
    );
  }
  @Post('sources/:workflow/:resourceId/restore') @HttpCode(200) restore(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('workflow') w: string,
    @Param('resourceId') id: string,
    @Body() body: unknown,
  ) {
    const v = record(body, [
      'operationId',
      'expectedVersion',
      'versionNumber',
      'expectedContentHash',
    ]);
    if (
      typeof v.expectedContentHash !== 'string' ||
      !/^[a-f\d]{64}$/.test(v.expectedContentHash)
    )
      throw bad();
    const { expectedContentHash, ...rest } = v;
    return this.editor.restoreEditor(
      captureDraftHeaders(req, true),
      objectId(p),
      workflow(w),
      objectId(id),
      { ...parseDraftInput('restore', rest), expectedContentHash },
    );
  }
}
