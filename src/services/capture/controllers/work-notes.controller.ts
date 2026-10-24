import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import type {
  DocumentStatus,
  WorkReportStatus,
} from '../application/work-notes.types';
import { WorkNotesService } from '../application/work-notes.service';
import {
  positiveInteger,
  validateProjectDocumentInput,
  validateReportFrequency,
  validateReviewInput,
  validateTaskNoteInput,
  validateWorkReportInput,
} from '../application/work-notes.validation';

const documentStatuses: readonly DocumentStatus[] = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
  'REJECTED',
  'ARCHIVED',
];
const workReportStatuses: readonly WorkReportStatus[] = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
  'REJECTED',
  'OVERDUE',
];

function invalid(): never {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed.',
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}

function assertQueryKeys(
  query: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(query).some((key) => !keys.includes(key))) invalid();
}

function optionalStatus<T extends string>(
  value: unknown,
  accepted: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !accepted.includes(value as T))
    return invalid();
  return value as T;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

@Controller('capture/projects/:projectId')
export class WorkNotesController {
  constructor(private readonly service: WorkNotesService) {}

  @Get('tasks/:taskId/notes')
  listTaskNotes(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    assertQueryKeys(rawQuery, ['page', 'pageSize']);
    return this.service.listTaskNotes(
      this.requestHeaders(request),
      projectId,
      taskId,
      positiveInteger(rawQuery.page, 1, Number.MAX_SAFE_INTEGER),
      positiveInteger(rawQuery.pageSize, 20, 100),
    );
  }

  @Post('tasks/:taskId/notes')
  createTaskNote(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
  ) {
    return this.service.createTaskNote(
      this.requestHeaders(request),
      projectId,
      taskId,
      validateTaskNoteInput(body),
    );
  }

  @Get('tasks/:taskId/notes/:noteId')
  getTaskNote(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Param('noteId') noteId: string,
  ) {
    return this.service.getTaskNote(
      this.requestHeaders(request),
      projectId,
      taskId,
      noteId,
    );
  }

  @Get('work-notes')
  listProjectTaskNotes(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    assertQueryKeys(rawQuery, ['page', 'pageSize', 'taskId']);
    if (rawQuery.taskId !== undefined && typeof rawQuery.taskId !== 'string')
      invalid();
    return this.service.listProjectTaskNotes(
      this.requestHeaders(request),
      projectId,
      positiveInteger(rawQuery.page, 1, Number.MAX_SAFE_INTEGER),
      positiveInteger(rawQuery.pageSize, 20, 100),
      rawQuery.taskId,
    );
  }

  @Get('documents')
  listDocuments(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    assertQueryKeys(rawQuery, ['page', 'pageSize', 'status']);
    return this.service.listDocuments(
      this.requestHeaders(request),
      projectId,
      positiveInteger(rawQuery.page, 1, Number.MAX_SAFE_INTEGER),
      positiveInteger(rawQuery.pageSize, 20, 100),
      optionalStatus(rawQuery.status, documentStatuses),
    );
  }

  @Post('documents')
  createDocument(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return this.service.createDocument(
      this.requestHeaders(request),
      projectId,
      validateProjectDocumentInput(body),
    );
  }

  @Get('documents/:documentId')
  getDocument(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.service.getDocument(
      this.requestHeaders(request),
      projectId,
      documentId,
    );
  }

  @Patch('documents/:documentId')
  updateDocumentDraft(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    return this.service.updateDocumentDraft(
      this.requestHeaders(request),
      projectId,
      documentId,
      validateProjectDocumentInput(body),
    );
  }

  @Post('documents/:documentId/submit')
  @HttpCode(HttpStatus.OK)
  submitDocument(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.service.submitDocument(
      this.requestHeaders(request),
      projectId,
      documentId,
    );
  }

  @Post('documents/:documentId/approve')
  @HttpCode(HttpStatus.OK)
  approveDocument(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    return this.service.reviewDocument(
      this.requestHeaders(request),
      projectId,
      documentId,
      'APPROVED',
      validateReviewInput(body, false),
    );
  }

  @Post('documents/:documentId/request-changes')
  @HttpCode(HttpStatus.OK)
  requestDocumentChanges(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    return this.service.reviewDocument(
      this.requestHeaders(request),
      projectId,
      documentId,
      'CHANGES_REQUESTED',
      validateReviewInput(body, true),
    );
  }

  @Post('documents/:documentId/reject')
  @HttpCode(HttpStatus.OK)
  rejectDocument(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    return this.service.reviewDocument(
      this.requestHeaders(request),
      projectId,
      documentId,
      'REJECTED',
      validateReviewInput(body, true),
    );
  }

  @Post('documents/:documentId/archive')
  @HttpCode(HttpStatus.OK)
  archiveDocument(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.service.archiveDocument(
      this.requestHeaders(request),
      projectId,
      documentId,
    );
  }

  @Get('work-report-settings')
  getWorkReportSettings(
    @Req() request: Request,
    @Param('projectId') projectId: string,
  ) {
    return this.service.getWorkReportSettings(
      this.requestHeaders(request),
      projectId,
    );
  }

  @Patch('work-report-settings')
  updateWorkReportSettings(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    const value = record(body);
    if (Object.keys(value).some((key) => key !== 'frequency')) invalid();
    return this.service.updateWorkReportSettings(
      this.requestHeaders(request),
      projectId,
      validateReportFrequency(value.frequency),
    );
  }

  @Get('work-reports')
  listWorkReports(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    assertQueryKeys(rawQuery, ['page', 'pageSize', 'status']);
    return this.service.listWorkReports(
      this.requestHeaders(request),
      projectId,
      positiveInteger(rawQuery.page, 1, Number.MAX_SAFE_INTEGER),
      positiveInteger(rawQuery.pageSize, 20, 100),
      optionalStatus(rawQuery.status, workReportStatuses),
    );
  }

  @Post('work-reports')
  @HttpCode(HttpStatus.OK)
  saveCurrentWorkReportDraft(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return this.service.saveCurrentWorkReportDraft(
      this.requestHeaders(request),
      projectId,
      validateWorkReportInput(body),
    );
  }

  @Get('work-reports/:reportId')
  getWorkReport(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
  ) {
    return this.service.getWorkReport(
      this.requestHeaders(request),
      projectId,
      reportId,
    );
  }

  @Patch('work-reports/:reportId')
  updateWorkReportDraft(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
    @Body() body: unknown,
  ) {
    return this.service.updateWorkReportDraft(
      this.requestHeaders(request),
      projectId,
      reportId,
      validateWorkReportInput(body),
    );
  }

  @Post('work-reports/:reportId/submit')
  @HttpCode(HttpStatus.OK)
  submitWorkReport(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
  ) {
    return this.service.submitWorkReport(
      this.requestHeaders(request),
      projectId,
      reportId,
    );
  }

  @Post('work-reports/:reportId/approve')
  @HttpCode(HttpStatus.OK)
  approveWorkReport(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
    @Body() body: unknown,
  ) {
    return this.service.reviewWorkReport(
      this.requestHeaders(request),
      projectId,
      reportId,
      'APPROVED',
      validateReviewInput(body, false),
    );
  }

  @Post('work-reports/:reportId/request-changes')
  @HttpCode(HttpStatus.OK)
  requestWorkReportChanges(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
    @Body() body: unknown,
  ) {
    return this.service.reviewWorkReport(
      this.requestHeaders(request),
      projectId,
      reportId,
      'CHANGES_REQUESTED',
      validateReviewInput(body, true),
    );
  }

  @Post('work-reports/:reportId/reject')
  @HttpCode(HttpStatus.OK)
  rejectWorkReport(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
    @Body() body: unknown,
  ) {
    return this.service.reviewWorkReport(
      this.requestHeaders(request),
      projectId,
      reportId,
      'REJECTED',
      validateReviewInput(body, true),
    );
  }

  private requestHeaders(request: Request) {
    return {
      authorization: headerValue(request.headers.authorization),
      cookie: headerValue(request.headers.cookie),
      organizationId: headerValue(request.headers['x-organization-id']),
      requestId: headerValue(request.headers['x-request-id']),
    };
  }
}
