import {
  Controller,
  Delete,
  Get,
  GatewayTimeoutException,
  Post,
  Patch,
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
  'x-csrf-token',
  'x-request-id',
] as const;
const responseHeaders = [
  'cache-control',
  'content-type',
  'retry-after',
  'www-authenticate',
  'x-request-id',
] as const;

@Controller()
export class GatewayChatController {
  constructor(private readonly config: ConfigService) {}

  @Get('chat/conversations/:conversationId')
  conversation(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }
  @Get('chat/conversations/:conversationId/preferences')
  feature0(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('chat/conversations/:conversationId/preferences')
  feature1(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('chat/conversations/:conversationId/draft')
  feature2(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put('chat/conversations/:conversationId/draft')
  feature3(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/conversations/:conversationId/ownership')
  feature4(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put('chat/conversations/:conversationId/managers/:userId')
  feature5(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('chat/messages/search')
  feature6(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('chat/conversations/:conversationId/library')
  feature7(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put('chat/conversations/:conversationId/messages/:messageId/pin')
  feature8(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/conversations/:conversationId/forward')
  feature9(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('chat/conversations/:conversationId/messages/:messageId/receipts')
  feature10(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('chat/notifications')
  feature11(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put('chat/notifications/:notificationId/read')
  feature12(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put('chat/blocks/:userId')
  feature13(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/reports')
  feature14(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('chat/candidates')
  searchCandidates(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('chat/conversations')
  listConversations(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/direct')
  createDirect(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/rooms')
  createRoom(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('chat/conversations/:conversationId/room')
  renameRoom(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/conversations/:conversationId/members')
  addRoomMembers(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Delete('chat/conversations/:conversationId/members/:userId')
  removeRoomMember(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/conversations/:conversationId/leave')
  leaveRoom(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('chat/conversations/:conversationId/messages')
  listMessages(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get('chat/conversations/:conversationId/messages/search')
  searchMessages(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/conversations/:conversationId/uploads')
  createUpload(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put('chat/conversations/:conversationId/uploads/:uploadId/content')
  uploadContent(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/conversations/:conversationId/uploads/:uploadId/complete')
  completeUpload(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Get(
    'chat/conversations/:conversationId/attachments/:attachmentId/download-url',
  )
  getAttachmentDownloadUrl(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/conversations/:conversationId/messages')
  sendMessage(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Patch('chat/conversations/:conversationId/messages/:messageId')
  editMessage(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Delete('chat/conversations/:conversationId/messages/:messageId')
  deleteMessage(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Put(
    'chat/conversations/:conversationId/messages/:messageId/reactions/:emoji',
  )
  setMessageReaction(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Delete(
    'chat/conversations/:conversationId/messages/:messageId/reactions/:emoji',
  )
  removeMessageReaction(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/conversations/:conversationId/read')
  markRead(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/conversations/:conversationId/delivered')
  markDelivered(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  @Post('chat/ws-ticket')
  createWsTicket(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  private async forward(request: Request, response: Response): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    const baseUrl = this.config.getOrThrow<string>('CHAT_SERVICE_URL');
    const path = request.originalUrl.replace(/^\/api\/v1\//, '/internal/');
    const headers: Record<string, string> = {};
    for (const name of requestHeaders) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    let upstream: globalThis.Response;
    const isUploadContent =
      request.method === 'PUT' &&
      /^\/api\/v1\/chat\/conversations\/[^/]+\/uploads\/[^/]+\/content$/.test(
        request.path,
      );
    try {
      upstream = await fetch(new URL(path, baseUrl), {
        method: request.method,
        headers,
        ...(isUploadContent
          ? {
              body: request as unknown as BodyInit,
              duplex: 'half',
            }
          : request.body === undefined
            ? {}
            : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(
          this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS'),
        ),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GatewayTimeoutException('Chat service timed out');
      }
      throw new ServiceUnavailableException('Chat service unavailable');
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
