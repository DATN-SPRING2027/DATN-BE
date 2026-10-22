import {
  Controller,
  Body,
  Get,
  Headers,
  Post,
  Query,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import { UserDirectoryService } from '../application/users/user-directory.service';

@Controller('iam/chat-candidates')
export class ChatCandidateController {
  constructor(
    private readonly auth: AuthenticationApplicationService,
    private readonly directory: UserDirectoryService,
  ) {}

  @Get()
  async search(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query('search') search: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      typeof search !== 'string' ||
      search.trim().length < 2 ||
      search.length > 80
    ) {
      throw new UnprocessableEntityException({
        code: 'CHAT_SEARCH_INVALID',
        message: 'Search must contain between 2 and 80 characters.',
      });
    }
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return {
      actor: { id: actor.id, organizationId: actor.organizationId },
      data: await this.directory.searchChatCandidates(actor, search.trim()),
    };
  }

  @Post('resolve')
  async resolveMany(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'userIds') ||
      !Array.isArray((body as { userIds?: unknown }).userIds) ||
      (body as { userIds: unknown[] }).userIds.length > 49 ||
      !(body as { userIds: unknown[] }).userIds.every(
        (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id),
      )
    ) {
      throw new UnprocessableEntityException({
        code: 'CHAT_PARTICIPANTS_INVALID',
        message: 'Participants are invalid.',
      });
    }
    const actor = await this.auth.getCurrentIdentity(authorization, cookie);
    return {
      actor: {
        id: actor.id,
        name: actor.name,
        organizationId: actor.organizationId,
      },
      data: await this.directory.getChatCandidates(
        actor,
        (body as { userIds: string[] }).userIds,
      ),
    };
  }
}
