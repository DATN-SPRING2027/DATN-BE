import { UseGuards } from '@nestjs/common';
import { ChatTrafficGuard } from './chat-traffic.guard';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Patch,
  Put,
  Req,
  Res,
  Query,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ChatApplicationService } from '../application/chat.service';
import type { ChatCredentials } from '../application/chat-iam.client';

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function requestCredentials(request: Request): ChatCredentials {
  const authorization = request.headers.authorization;
  const cookie = request.headers.cookie;
  const organizationId = readHeader(request, 'x-organization-id');
  const expectedOrganizationId = readHeader(
    request,
    'x-expected-organization-id',
  );
  return {
    ...(authorization ? { authorization } : {}),
    ...(cookie ? { cookie } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(expectedOrganizationId ? { expectedOrganizationId } : {}),
  };
}

@Controller('chat')
@UseGuards(ChatTrafficGuard)
export class ChatController {
  constructor(private readonly service: ChatApplicationService) {}

  @Get('candidates')
  @Header('Cache-Control', 'no-store')
  searchCandidates(@Req() request: Request, @Query('search') search: unknown) {
    return this.service.searchCandidates(requestCredentials(request), search);
  }

  @Get('conversations')
  @Header('Cache-Control', 'no-store')
  listConversations(
    @Req() request: Request,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.listConversations(requestCredentials(request), query);
  }

  @Post('direct')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  createDirect(@Req() request: Request, @Body() body: unknown) {
    return this.service.createDirect(requestCredentials(request), body);
  }

  @Post('rooms')
  @Header('Cache-Control', 'no-store')
  createRoom(@Req() request: Request, @Body() body: unknown) {
    return this.service.createRoom(requestCredentials(request), body);
  }

  @Patch('conversations/:conversationId/room')
  @Header('Cache-Control', 'no-store')
  renameRoom(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.renameRoom(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Post('conversations/:conversationId/members')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  addRoomMembers(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.addRoomMembers(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Delete('conversations/:conversationId/members/:userId')
  @Header('Cache-Control', 'no-store')
  removeRoomMember(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('userId') userId: string,
  ) {
    return this.service.removeRoomMember(
      requestCredentials(request),
      conversationId,
      userId,
    );
  }

  @Post('conversations/:conversationId/leave')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  leaveRoom(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.leaveRoom(requestCredentials(request), conversationId);
  }

  @Get('conversations/:conversationId/messages')
  @Header('Cache-Control', 'no-store')
  listMessages(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.listMessages(
      requestCredentials(request),
      conversationId,
      query,
    );
  }

  @Get('conversations/:conversationId/messages/search')
  @Header('Cache-Control', 'no-store')
  searchMessages(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.searchMessages(
      requestCredentials(request),
      conversationId,
      query,
    );
  }

  @Post('conversations/:conversationId/uploads')
  @Header('Cache-Control', 'no-store')
  createUpload(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.createUpload(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Put('conversations/:conversationId/uploads/:uploadId/content')
  @Header('Cache-Control', 'no-store')
  uploadContent(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('uploadId') uploadId: string,
  ) {
    return this.service.uploadContent(
      requestCredentials(request),
      conversationId,
      uploadId,
      request,
    );
  }

  @Post('conversations/:conversationId/uploads/:uploadId/complete')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  completeUpload(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('uploadId') uploadId: string,
  ) {
    return this.service.completeUpload(
      requestCredentials(request),
      conversationId,
      uploadId,
    );
  }

  @Get('conversations/:conversationId/attachments/:attachmentId/download-url')
  @Header('Cache-Control', 'no-store')
  getAttachmentDownloadUrl(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.service.getAttachmentDownloadUrl(
      requestCredentials(request),
      conversationId,
      attachmentId,
    );
  }

  @Get('conversations/:conversationId/attachments/:attachmentId/content')
  async downloadAttachmentContent(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.service.getAttachmentStream(
      requestCredentials(request),
      conversationId,
      attachmentId,
    );
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', 'sandbox');
    if (typeof file.size === 'number' && Number.isFinite(file.size)) {
      response.setHeader('Content-Length', String(file.size));
    }
    file.stream.on('error', () => {
      if (!response.headersSent) {
        response.status(503).end();
      } else {
        response.destroy();
      }
    });
    response.on('close', () => {
      if (!file.stream.destroyed) {
        file.stream.destroy();
      }
    });
    file.stream.pipe(response);
  }

  @Post('conversations/:conversationId/messages')
  @Header('Cache-Control', 'no-store')
  sendMessage(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.sendMessage(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Patch('conversations/:conversationId/messages/:messageId')
  @Header('Cache-Control', 'no-store')
  editMessage(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.service.editMessage(
      requestCredentials(request),
      conversationId,
      messageId,
      body,
    );
  }

  @Delete('conversations/:conversationId/messages/:messageId')
  @Header('Cache-Control', 'no-store')
  deleteMessage(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.service.deleteMessage(
      requestCredentials(request),
      conversationId,
      messageId,
    );
  }

  @Put('conversations/:conversationId/messages/:messageId/reactions/:emoji')
  @Header('Cache-Control', 'no-store')
  setMessageReaction(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Param('emoji') emoji: string,
  ) {
    return this.service.setMessageReaction(
      requestCredentials(request),
      conversationId,
      messageId,
      emoji,
      true,
    );
  }

  @Delete('conversations/:conversationId/messages/:messageId/reactions/:emoji')
  @Header('Cache-Control', 'no-store')
  removeMessageReaction(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Param('emoji') emoji: string,
  ) {
    return this.service.setMessageReaction(
      requestCredentials(request),
      conversationId,
      messageId,
      emoji,
      false,
    );
  }

  @Post('conversations/:conversationId/read')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  markRead(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.markRead(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Post('conversations/:conversationId/delivered')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  markDelivered(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.markDelivered(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Post('ws-ticket')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  createWsTicket(@Req() request: Request) {
    return this.service.createWsTicket(requestCredentials(request));
  }
}
