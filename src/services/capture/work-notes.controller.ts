import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProjectWorkNotesService } from './work-notes.service';

@Controller([
  'projects/:projectId/work-notes',
  'internal/projects/:projectId/work-notes',
])
export class ProjectWorkNotesController {
  constructor(private readonly workNotesService: ProjectWorkNotesService) {}

  @Get()
  async listNotes(
    @Param('projectId') projectId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-organization-id') headerOrgId: string | undefined,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    return this.workNotesService.listProjectWorkNotes({
      authorizationHeader: authorization,
      cookieHeader: cookie,
      headerOrgId,
      projectId,
    });
  }

  @Get(':noteId')
  async getNote(
    @Param('projectId') projectId: string,
    @Param('noteId') noteId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-organization-id') headerOrgId: string | undefined,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    return this.workNotesService.getProjectWorkNote({
      authorizationHeader: authorization,
      cookieHeader: cookie,
      headerOrgId,
      projectId,
      noteId,
    });
  }

  @Post()
  async createNote(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-organization-id') headerOrgId: string | undefined,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    return this.workNotesService.createProjectWorkNote({
      authorizationHeader: authorization,
      cookieHeader: cookie,
      csrfHeader,
      headerOrgId,
      projectId,
      body,
    });
  }

  @Patch(':noteId')
  async updateNote(
    @Param('projectId') projectId: string,
    @Param('noteId') noteId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-organization-id') headerOrgId: string | undefined,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    return this.workNotesService.updateProjectWorkNote({
      authorizationHeader: authorization,
      cookieHeader: cookie,
      csrfHeader,
      headerOrgId,
      projectId,
      noteId,
      body,
    });
  }

  @Delete(':noteId')
  async deleteNote(
    @Param('projectId') projectId: string,
    @Param('noteId') noteId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Headers('x-organization-id') headerOrgId: string | undefined,
    @Res({ passthrough: true }) response?: Response,
  ) {
    response?.setHeader('Cache-Control', 'no-store');
    return this.workNotesService.deleteProjectWorkNote({
      authorizationHeader: authorization,
      cookieHeader: cookie,
      csrfHeader,
      headerOrgId,
      projectId,
      noteId,
    });
  }
}
