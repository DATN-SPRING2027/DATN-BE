import { UseGuards } from '@nestjs/common';
import { ChatTrafficGuard } from './chat-traffic.guard';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Patch,
  Put,
  Req,
  Query,
} from '@nestjs/common';
import type { Request } from 'express';
import { ChatApplicationService } from '../application/chat.service';
import type { ChatCredentials } from '../application/chat-iam.client';

function credentials(
  authorization: string | undefined,
  cookie: string | undefined,
): ChatCredentials {
  return {
    ...(authorization ? { authorization } : {}),
    ...(cookie ? { cookie } : {}),
  };
}

@Controller('chat')
@UseGuards(ChatTrafficGuard)
export class ChatController {
  constructor(private readonly service: ChatApplicationService) {}

  @Get('candidates')
  @Header('Cache-Control', 'no-store')
  searchCandidates(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query('search') search: unknown,
  ) {
    return this.service.searchCandidates(
      credentials(authorization, cookie),
      search,
    );
  }

  @Get('conversations')
  @Header('Cache-Control', 'no-store')
  listConversations(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.listConversations(
      credentials(authorization, cookie),
      query,
    );
  }

  @Post('direct')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  createDirect(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
  ) {
    return this.service.createDirect(credentials(authorization, cookie), body);
  }

  @Post('rooms')
  @Header('Cache-Control', 'no-store')
  createRoom(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
  ) {
    return this.service.createRoom(credentials(authorization, cookie), body);
  }

  @Patch('conversations/:conversationId/room')
  @Header('Cache-Control', 'no-store')
  renameRoom(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.renameRoom(
      credentials(authorization, cookie),
      conversationId,
      body,
    );
  }

  @Post('conversations/:conversationId/members')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  addRoomMembers(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.addRoomMembers(
      credentials(authorization, cookie),
      conversationId,
      body,
    );
  }

  @Delete('conversations/:conversationId/members/:userId')
  @Header('Cache-Control', 'no-store')
  removeRoomMember(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Param('userId') userId: string,
  ) {
    return this.service.removeRoomMember(
      credentials(authorization, cookie),
      conversationId,
      userId,
    );
  }

  @Post('conversations/:conversationId/leave')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  leaveRoom(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.leaveRoom(
      credentials(authorization, cookie),
      conversationId,
    );
  }

  @Get('conversations/:conversationId/messages')
  @Header('Cache-Control', 'no-store')
  listMessages(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.listMessages(
      credentials(authorization, cookie),
      conversationId,
      query,
    );
  }

  @Get('conversations/:conversationId/messages/search')
  @Header('Cache-Control', 'no-store')
  searchMessages(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.searchMessages(
      credentials(authorization, cookie),
      conversationId,
      query,
    );
  }

  @Post('conversations/:conversationId/uploads')
  @Header('Cache-Control', 'no-store')
  createUpload(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.createUpload(
      credentials(authorization, cookie),
      conversationId,
      body,
    );
  }

  @Put('conversations/:conversationId/uploads/:uploadId/content')
  @Header('Cache-Control', 'no-store')
  uploadContent(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Param('uploadId') uploadId: string,
    @Req() request: Request,
  ) {
    return this.service.uploadContent(
      credentials(authorization, cookie),
      conversationId,
      uploadId,
      request,
    );
  }

  @Post('conversations/:conversationId/uploads/:uploadId/complete')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  completeUpload(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Param('uploadId') uploadId: string,
  ) {
    return this.service.completeUpload(
      credentials(authorization, cookie),
      conversationId,
      uploadId,
    );
  }

  @Get('conversations/:conversationId/attachments/:attachmentId/download-url')
  @Header('Cache-Control', 'no-store')
  getAttachmentDownloadUrl(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.service.getAttachmentDownloadUrl(
      credentials(authorization, cookie),
      conversationId,
      attachmentId,
    );
  }

  @Post('conversations/:conversationId/messages')
  @Header('Cache-Control', 'no-store')
  sendMessage(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.sendMessage(
      credentials(authorization, cookie),
      conversationId,
      body,
    );
  }

  @Patch('conversations/:conversationId/messages/:messageId')
  @Header('Cache-Control', 'no-store')
  editMessage(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.service.editMessage(
      credentials(authorization, cookie),
      conversationId,
      messageId,
      body,
    );
  }

  @Delete('conversations/:conversationId/messages/:messageId')
  @Header('Cache-Control', 'no-store')
  deleteMessage(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.service.deleteMessage(
      credentials(authorization, cookie),
      conversationId,
      messageId,
    );
  }

  @Put('conversations/:conversationId/messages/:messageId/reactions/:emoji')
  @Header('Cache-Control', 'no-store')
  setMessageReaction(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Param('emoji') emoji: string,
  ) {
    return this.service.setMessageReaction(
      credentials(authorization, cookie),
      conversationId,
      messageId,
      emoji,
      true,
    );
  }

  @Delete('conversations/:conversationId/messages/:messageId/reactions/:emoji')
  @Header('Cache-Control', 'no-store')
  removeMessageReaction(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Param('emoji') emoji: string,
  ) {
    return this.service.setMessageReaction(
      credentials(authorization, cookie),
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
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.markRead(
      credentials(authorization, cookie),
      conversationId,
      body,
    );
  }

  @Post('conversations/:conversationId/delivered')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  markDelivered(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.markDelivered(
      credentials(authorization, cookie),
      conversationId,
      body,
    );
  }

  @Post('ws-ticket')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  createWsTicket(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
  ) {
    return this.service.createWsTicket(credentials(authorization, cookie));
  }
}
