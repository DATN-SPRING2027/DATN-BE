import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { WorkNoteAssessmentService } from '../application/work-note-agent/work-note-assessment.service';
import { parseAssessmentRequest } from '../application/work-note-agent/work-note-assessment.validation';
import type {
  AssessmentInput,
  AssessmentReply,
  AssessmentMutation,
  AssessmentCorrection,
  AssessmentReset,
} from '../application/work-note-agent/work-note-assessment.types';
import {
  objectId,
  uuidInput,
} from '../application/work-note-agent/work-note-agent-drafts.validation';
import { captureDraftHeaders } from './work-note-editor.http';
@Controller(
  'capture/projects/:projectId/work-note-drafts/:draftId/agent/assessments',
)
export class WorkNoteAssessmentController {
  constructor(private readonly service: WorkNoteAssessmentService) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  assess(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') d: string,
    @Body() b: unknown,
  ) {
    return this.service.assess(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(d),
      parseAssessmentRequest('assess', b) as AssessmentInput,
    );
  }
  @Post(':assessmentId/replies')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  reply(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') d: string,
    @Param('assessmentId') a: string,
    @Body() b: unknown,
  ) {
    return this.service.reply(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(d),
      uuidInput(a),
      parseAssessmentRequest('reply', b) as AssessmentReply,
    );
  }
  @Post(':assessmentId/rewrite')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  rewrite(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') d: string,
    @Param('assessmentId') a: string,
    @Body() b: unknown,
  ) {
    return this.service.rewriteAssessment(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(d),
      uuidInput(a),
      parseAssessmentRequest('rewrite', b) as AssessmentMutation,
    );
  }
  @Post(':assessmentId/corrections')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  correct(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') d: string,
    @Param('assessmentId') a: string,
    @Body() b: unknown,
  ) {
    return this.service.correct(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(d),
      uuidInput(a),
      parseAssessmentRequest('correct', b) as AssessmentCorrection,
    );
  }
  @Post(':assessmentId/reset')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  reset(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') d: string,
    @Param('assessmentId') a: string,
    @Body() b: unknown,
  ) {
    return this.service.resetAssessment(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(d),
      uuidInput(a),
      parseAssessmentRequest('reset', b) as AssessmentReset,
    );
  }
  @Post(':assessmentId/validate-author')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  validate(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') d: string,
    @Param('assessmentId') a: string,
    @Body() b: unknown,
  ) {
    return this.service.validateAuthor(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(d),
      uuidInput(a),
      parseAssessmentRequest('validate', b) as AssessmentMutation,
    );
  }
  @Post(':assessmentId/feedback')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  feedback(
    @Req() req: Request,
    @Param('projectId') p: string,
    @Param('draftId') d: string,
    @Param('assessmentId') a: string,
    @Body() b: unknown,
  ) {
    return this.service.feedback(
      captureDraftHeaders(req, true),
      objectId(p),
      uuidInput(d),
      uuidInput(a),
      parseAssessmentRequest('feedback', b) as AssessmentMutation & {
        category:
          | 'UNNECESSARY_QUESTION'
          | 'MISSING_QUESTION'
          | 'WRONG_SOURCE'
          | 'FALSE_SUFFICIENT';
      },
    );
  }
}
