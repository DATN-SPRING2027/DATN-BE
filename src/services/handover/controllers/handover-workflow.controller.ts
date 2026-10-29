import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { StructuredExceptionFilter } from '../../../common/http/structured-exception.filter';
import type { HandoverRequestHeaders } from '../application/handover.types';
import {
  HandoverWorkflowService,
  type HttpPayloadWithHeaders,
} from '../application/handover-workflow.service';

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

@Controller('handover/projects/:projectId/handovers')
@UseFilters(StructuredExceptionFilter)
export class HandoverWorkflowController {
  constructor(private readonly workflowService: HandoverWorkflowService) {}

  private extractHeaders(request: Request): HandoverRequestHeaders {
    return {
      authorization: headerValue(request.headers['authorization']),
      cookie: headerValue(request.headers['cookie']),
      csrfToken: headerValue(request.headers['x-csrf-token']),
      idempotencyKey: headerValue(request.headers['idempotency-key']),
      ifMatch: headerValue(request.headers['if-match']),
      organizationId: headerValue(request.headers['x-organization-id']),
      requestId: headerValue(request.headers['x-request-id']),
    };
  }

  private async respond<T>(
    response: Response,
    run: () => Promise<HttpPayloadWithHeaders<T>>,
  ): Promise<T> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await run();
    if (result.etag) {
      response.setHeader('ETag', result.etag);
    }
    if (result.replayed === true) {
      response.setHeader('Idempotency-Replayed', 'true');
    }
    return result.body;
  }

  @Get()
  listHandovers(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.listHandovers(
        projectId,
        query,
        this.extractHeaders(request),
      ),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createHandover(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.createHandover(
        projectId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Get(':handoverId')
  getHandover(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.getHandover(
        projectId,
        handoverId,
        this.extractHeaders(request),
      ),
    );
  }

  @Patch(':handoverId')
  @HttpCode(HttpStatus.OK)
  updateHandoverMetadata(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.updateHandoverMetadata(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Put(':handoverId/successor')
  @HttpCode(HttpStatus.OK)
  setHandoverSuccessor(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.setHandoverSuccessor(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Put(':handoverId/coordinator')
  @HttpCode(HttpStatus.OK)
  setHandoverCoordinator(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.setHandoverCoordinator(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Get(':handoverId/draft')
  getHandoverDraft(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.getHandoverDraft(
        projectId,
        handoverId,
        this.extractHeaders(request),
      ),
    );
  }

  @Put(':handoverId/draft')
  @HttpCode(HttpStatus.OK)
  replaceHandoverDraft(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.replaceHandoverDraft(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/source-proposals')
  @HttpCode(HttpStatus.ACCEPTED)
  proposeHandoverSources(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.proposeHandoverSources(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/generations')
  @HttpCode(HttpStatus.ACCEPTED)
  generateHandoverDraft(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.generateHandoverDraft(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Get(':handoverId/jobs/:jobId')
  getHandoverJob(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('jobId') jobId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.getHandoverJob(
        projectId,
        handoverId,
        jobId,
        this.extractHeaders(request),
      ),
    );
  }

  @Get(':handoverId/jobs/:jobId/candidates')
  getHandoverCandidates(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('jobId') jobId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.getHandoverCandidates(
        projectId,
        handoverId,
        jobId,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/jobs/:jobId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retryHandoverJob(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.retryHandoverJob(
        projectId,
        handoverId,
        jobId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/revisions')
  @HttpCode(HttpStatus.CREATED)
  publishHandoverRevision(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.publishHandoverRevision(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Get(':handoverId/revisions/:revisionId')
  getHandoverRevision(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('revisionId') revisionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.getHandoverRevision(
        projectId,
        handoverId,
        revisionId,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/acceptance')
  @HttpCode(HttpStatus.OK)
  acceptHandoverPackage(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.acceptHandoverPackage(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/questions')
  @HttpCode(HttpStatus.OK)
  askHandoverQuestion(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.askHandoverQuestion(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/items/:itemId/acknowledgements')
  @HttpCode(HttpStatus.OK)
  acknowledgeHandoverItem(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.acknowledgeHandoverItem(
        projectId,
        handoverId,
        itemId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Get(':handoverId/items/:itemId/evidence')
  listItemEvidence(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('itemId') itemId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.listItemEvidence(
        projectId,
        handoverId,
        itemId,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/items/:itemId/evidence')
  @HttpCode(HttpStatus.CREATED)
  submitHandoverEvidence(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.submitHandoverEvidence(
        projectId,
        handoverId,
        itemId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/items/:itemId/evidence/:evidenceId/reviews')
  @HttpCode(HttpStatus.OK)
  reviewHandoverEvidence(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('itemId') itemId: string,
    @Param('evidenceId') evidenceId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.reviewHandoverEvidence(
        projectId,
        handoverId,
        itemId,
        evidenceId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/items/:itemId/exceptions')
  @HttpCode(HttpStatus.CREATED)
  acceptOptionalHandoverGap(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.acceptOptionalHandoverGap(
        projectId,
        handoverId,
        itemId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Get(':handoverId/task-transfers')
  listHandoverTaskTransfers(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.listHandoverTaskTransfers(
        projectId,
        handoverId,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/task-transfers')
  @HttpCode(HttpStatus.ACCEPTED)
  startHandoverTaskTransfer(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.startHandoverTaskTransfer(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Get(':handoverId/task-transfers/:transferId')
  getHandoverTaskTransfer(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('transferId') transferId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.getHandoverTaskTransfer(
        projectId,
        handoverId,
        transferId,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/task-transfers/:transferId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcileHandoverTaskTransfer(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('transferId') transferId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.reconcileHandoverTaskTransfer(
        projectId,
        handoverId,
        transferId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/completion')
  @HttpCode(HttpStatus.OK)
  completeHandover(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.completeHandover(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/cancellation')
  @HttpCode(HttpStatus.OK)
  cancelHandover(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.cancelHandover(
        projectId,
        handoverId,
        body,
        this.extractHeaders(request),
      ),
    );
  }

  @Get(':handoverId/follow-ups')
  listHandoverFollowUps(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.listHandoverFollowUps(
        projectId,
        handoverId,
        query,
        this.extractHeaders(request),
      ),
    );
  }

  @Post(':handoverId/follow-ups/:followupId/resolution')
  @HttpCode(HttpStatus.OK)
  resolveHandoverFollowUp(
    @Param('projectId') projectId: string,
    @Param('handoverId') handoverId: string,
    @Param('followupId') followupId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(response, () =>
      this.workflowService.resolveHandoverFollowUp(
        projectId,
        handoverId,
        followupId,
        body,
        this.extractHeaders(request),
      ),
    );
  }
}
