import {
  Controller,
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
  'idempotency-key',
  'if-match',
  'x-csrf-token',
  'x-organization-id',
  'x-request-id',
] as const;

const responseHeaders = [
  'cache-control',
  'content-type',
  'etag',
  'idempotency-replayed',
  'location',
  'retry-after',
  'www-authenticate',
  'x-request-id',
] as const;

@Controller('handover/projects/:projectId/handovers')
export class GatewayHandoverController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  listHandovers(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post()
  createHandover(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(':handoverId')
  getHandover(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch(':handoverId')
  updateHandoverMetadata(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put(':handoverId/successor')
  setHandoverSuccessor(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put(':handoverId/coordinator')
  setHandoverCoordinator(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(':handoverId/draft')
  getHandoverDraft(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put(':handoverId/draft')
  replaceHandoverDraft(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/source-proposals')
  proposeHandoverSources(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/generations')
  generateHandoverDraft(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(':handoverId/jobs/:jobId')
  getHandoverJob(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(':handoverId/jobs/:jobId/candidates')
  getHandoverCandidates(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/jobs/:jobId/retry')
  retryHandoverJob(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/revisions')
  publishHandoverRevision(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(':handoverId/revisions/:revisionId')
  getHandoverRevision(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/acceptance')
  acceptHandoverPackage(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/questions')
  askHandoverQuestion(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/items/:itemId/acknowledgements')
  acknowledgeHandoverItem(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(':handoverId/items/:itemId/evidence')
  listItemEvidence(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/items/:itemId/evidence')
  submitHandoverEvidence(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/items/:itemId/evidence/:evidenceId/reviews')
  reviewHandoverEvidence(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/items/:itemId/exceptions')
  acceptOptionalHandoverGap(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.forward(request, response);
  }

  @Get(':handoverId/task-transfers')
  listHandoverTaskTransfers(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.forward(request, response);
  }

  @Post(':handoverId/task-transfers')
  startHandoverTaskTransfer(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.forward(request, response);
  }

  @Get(':handoverId/task-transfers/:transferId')
  getHandoverTaskTransfer(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/task-transfers/:transferId/reconciliation')
  reconcileHandoverTaskTransfer(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    return this.forward(request, response);
  }

  @Post(':handoverId/completion')
  completeHandover(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/cancellation')
  cancelHandover(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(':handoverId/follow-ups')
  listHandoverFollowUps(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post(':handoverId/follow-ups/:followupId/resolution')
  resolveHandoverFollowUp(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  private async forward(request: Request, response: Response): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    const path = request.originalUrl.replace(/^\/api\/v1\//, '/internal/');
    const baseUrl = this.config.getOrThrow<string>('HANDOVER_SERVICE_URL');
    const headers: Record<string, string> = {};
    for (const name of requestHeaders) {
      const value = request.headers[name];
      if (typeof value === 'string') {
        headers[name] = value;
      }
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
        throw new GatewayTimeoutException('Handover service timed out');
      }
      throw new ServiceUnavailableException('Handover service unavailable');
    }

    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) {
        response.setHeader(name, value);
      }
    }
    response
      .status(upstream.status)
      .send(Buffer.from(await upstream.arrayBuffer()));
  }
}
