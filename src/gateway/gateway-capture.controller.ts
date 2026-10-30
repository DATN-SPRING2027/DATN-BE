import {
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Patch,
  Post,
  Put,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

const requestHeaders = [
  'accept',
  'authorization',
  'content-type',
  'cookie',
  'x-auto-sync-sag',
  'x-content-sha256',
  'x-csrf-token',
  'x-file-name',
  'x-organization-id',
  'x-request-id',
] as const;

const responseHeaders = [
  'cache-control',
  'content-type',
  'content-disposition',
  'location',
  'retry-after',
  'www-authenticate',
  'x-content-type-options',
  'x-request-id',
] as const;

@Controller('capture/projects/:projectId')
export class GatewayCaptureController {
  constructor(private readonly config: ConfigService) {}

  @Get('tasks/:taskId/notes')
  listTaskNotes(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('tasks/:taskId/notes')
  createTaskNote(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('tasks/:taskId/notes/:noteId')
  updateTaskNote(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Delete('tasks/:taskId/notes/:noteId')
  deleteTaskNote(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('tasks/:taskId/notes/:noteId')
  getTaskNote(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('work-notes')
  listProjectTaskNotes(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('work-notes/:noteId')
  getProjectTaskNote(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('documents')
  listDocuments(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('documents')
  createDocument(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('documents/:documentId')
  getDocument(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('documents/:documentId')
  updateDocumentDraft(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put('documents/:documentId/file')
  uploadDocumentFile(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/file/upload-intent')
  createDocumentUploadIntent(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/file/confirm-upload')
  confirmDocumentUpload(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('documents/:documentId/file')
  downloadDocumentFile(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/submit')
  submitDocument(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/comment')
  commentDocument(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/approve')
  approveDocument(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/request-changes')
  requestDocumentChanges(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/reject')
  rejectDocument(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/archive')
  archiveDocument(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('documents/:documentId/knowledge-status')
  getDocumentKnowledgeStatus(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.forward(request, response);
  }

  @Get('documents/:documentId/knowledge-chunks')
  getDocumentKnowledgeChunks(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/knowledge-sync')
  syncDocumentToSag(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('documents/:documentId/knowledge-control')
  controlDocumentKnowledge(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('work-report-settings')
  getWorkReportSettings(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('work-report-settings')
  updateWorkReportSettings(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('work-reports')
  listWorkReports(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('work-reports')
  saveCurrentWorkReportDraft(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.forward(request, response);
  }

  @Get('work-reports/:reportId')
  getWorkReport(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('work-reports/:reportId')
  updateWorkReportDraft(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('work-reports/:reportId/submit')
  submitWorkReport(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('work-reports/:reportId/approve')
  approveWorkReport(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('work-reports/:reportId/request-changes')
  requestWorkReportChanges(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('work-reports/:reportId/reject')
  rejectWorkReport(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  private async forward(request: Request, response: Response): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    const baseUrl = this.config.getOrThrow<string>('CAPTURE_SERVICE_URL');
    const path = request.originalUrl.replace(/^\/api\/v1\//, '/internal/');
    const headers: Record<string, string> = {};
    for (const name of requestHeaders) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    const fileTransfer =
      /^\/api\/v1\/capture\/projects\/[^/]+\/(?:documents|work-reports)\/[^/]+\/file(?:\?|$)/.test(
        request.originalUrl,
      );
    const streamUpload = request.method === 'PUT' && fileTransfer;
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : streamUpload
          ? (request as unknown as BodyInit)
          : request.body === undefined
            ? undefined
            : JSON.stringify(request.body);

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(new URL(path, baseUrl), {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(streamUpload ? { duplex: 'half' } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(
          this.config.getOrThrow<number>(
            fileTransfer ? 'CAPTURE_FILE_TIMEOUT_MS' : 'BACKEND_TIMEOUT_MS',
          ),
        ),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException('Capture service timed out');
      }
      throw new ServiceUnavailableException('Capture service unavailable');
    }

    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    response
      .status(upstream.status)
      .send(Buffer.from(await upstream.arrayBuffer()));
  }
}
