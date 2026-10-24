import {
  Controller,
  GatewayTimeoutException,
  Get,
  Patch,
  Post,
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
  'x-csrf-token',
  'x-organization-id',
  'x-request-id',
] as const;

const responseHeaders = [
  'cache-control',
  'content-type',
  'location',
  'retry-after',
  'www-authenticate',
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

  @Get('tasks/:taskId/notes/:noteId')
  getTaskNote(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('work-notes')
  listProjectTaskNotes(@Req() request: Request, @Res() response: Response) {
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

  @Post('documents/:documentId/submit')
  submitDocument(@Req() request: Request, @Res() response: Response) {
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

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(new URL(path, baseUrl), {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(
          this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS'),
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
