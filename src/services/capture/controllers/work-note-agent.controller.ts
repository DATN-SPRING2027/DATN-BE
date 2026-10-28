import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { WorkNoteAgentDraftsService } from '../application/work-note-agent/work-note-agent-drafts.service';
import {
  objectId,
  parseDraftInput,
  positive,
  uuidInput,
} from '../application/work-note-agent/work-note-agent-drafts.validation';
import { captureDraftHeaders } from './work-note-editor.http';

@Controller('capture/projects/:projectId')
export class WorkNoteAgentController {
  constructor(private readonly service: WorkNoteAgentDraftsService) {}
  private headers(request: Request, mutation = false) {
    return captureDraftHeaders(request, mutation);
  }
  @Post('work-note-drafts')
  @Header('Cache-Control', 'private, no-store')
  create(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Body() body: unknown,
  ) {
    return this.service.create(
      this.headers(req, true),
      objectId(project),
      parseDraftInput('create', body),
    );
  }
  @Get('work-note-drafts')
  @Header('Cache-Control', 'private, no-store')
  async resume(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ) {
    if (Object.keys(query).some((k) => !['taskId', 'noteId'].includes(k)))
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    const draft = await this.service.resume(
      this.headers(req),
      objectId(project),
      objectId(query.taskId),
      query.noteId === undefined ? undefined : objectId(query.noteId),
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.status(200).json(draft);
  }
  @Get('work-note-drafts/:draftId')
  @Header('Cache-Control', 'private, no-store')
  get(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Param('draftId') id: string,
  ) {
    return this.service.get(
      this.headers(req),
      objectId(project),
      uuidInput(id),
    );
  }
  @Patch('work-note-drafts/:draftId')
  @Header('Cache-Control', 'private, no-store')
  update(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.update(
      this.headers(req, true),
      objectId(project),
      uuidInput(id),
      parseDraftInput('update', body),
    );
  }
  @Delete('work-note-drafts/:draftId')
  @HttpCode(204)
  discard(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    const value = parseDraftInput('discard', body);
    return this.service.discard(
      this.headers(req, true),
      objectId(project),
      uuidInput(id),
      value.expectedRevision,
    );
  }
  @Post('work-note-drafts/:draftId/reset-chat')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  reset(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.reset(
      this.headers(req, true),
      objectId(project),
      uuidInput(id),
      parseDraftInput('reset', body),
    );
  }
  @Post('work-note-drafts/:draftId/agent/messages')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  message(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.message(
      this.headers(req, true),
      objectId(project),
      uuidInput(id),
      parseDraftInput('message', body),
    );
  }
  @Post('work-note-drafts/:draftId/agent/suggestions/:suggestionId/apply')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  apply(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Param('draftId') id: string,
    @Param('suggestionId') suggestion: string,
    @Body() body: unknown,
  ) {
    return this.service.apply(
      this.headers(req, true),
      objectId(project),
      uuidInput(id),
      uuidInput(suggestion),
      parseDraftInput('apply', body),
    );
  }
  @Post('work-note-drafts/:draftId/save')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  save(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Param('draftId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.save(
      this.headers(req, true),
      objectId(project),
      uuidInput(id),
      parseDraftInput('save', body),
    );
  }
  @Get('tasks/:taskId/notes/:noteId/versions')
  @Header('Cache-Control', 'private, no-store')
  versions(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Param('taskId') task: string,
    @Param('noteId') note: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (Object.keys(query).some((k) => !['page', 'pageSize'].includes(k)))
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    return this.service.versions(
      this.headers(req),
      objectId(project),
      objectId(task),
      objectId(note),
      positive(Number(query.page ?? 1)),
      positive(Number(query.pageSize ?? 20), 50),
    );
  }
  @Post('tasks/:taskId/notes/:noteId/restore')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  restore(
    @Req() req: Request,
    @Param('projectId') project: string,
    @Param('taskId') task: string,
    @Param('noteId') note: string,
    @Body() body: unknown,
  ) {
    return this.service.restore(
      this.headers(req, true),
      objectId(project),
      objectId(task),
      objectId(note),
      parseDraftInput('restore', body),
    );
  }
}
