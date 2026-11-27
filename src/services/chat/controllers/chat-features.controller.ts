import {
  Body,
  Controller,
  Get,
  Put,
  Patch,
  Post,
  Param,
  Query,
  Req,
  Header,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ChatFeaturesService } from '../application/chat-features.service';
import type { ChatCredentials } from '../application/chat-iam.client';
import { ChatTrafficGuard } from './chat-traffic.guard';

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
export class ChatFeaturesController {
  constructor(private readonly service: ChatFeaturesService) {}

  @Get('conversations/:conversationId')
  @Header('Cache-Control', 'no-store')
  conversation(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.conversation(
      requestCredentials(request),
      conversationId,
    );
  }

  @Get('conversations/:conversationId/preferences')
  @Header('Cache-Control', 'no-store')
  preferences0(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.preferences(
      requestCredentials(request),
      conversationId,
    );
  }

  @Patch('conversations/:conversationId/preferences')
  @Header('Cache-Control', 'no-store')
  preferences1(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.preferences(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Get('conversations/:conversationId/draft')
  @Header('Cache-Control', 'no-store')
  draft2(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.draft(requestCredentials(request), conversationId);
  }

  @Put('conversations/:conversationId/draft')
  @Header('Cache-Control', 'no-store')
  draft3(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.draft(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Post('conversations/:conversationId/ownership')
  @Header('Cache-Control', 'no-store')
  ownership4(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.ownership(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Put('conversations/:conversationId/managers/:userId')
  @Header('Cache-Control', 'no-store')
  manager5(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    return this.service.manager(
      requestCredentials(request),
      conversationId,
      userId,
      body,
    );
  }

  @Get('messages/search')
  @Header('Cache-Control', 'no-store')
  search6(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.service.search(requestCredentials(request), query);
  }

  @Get('conversations/:conversationId/library')
  @Header('Cache-Control', 'no-store')
  library7(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.library(
      requestCredentials(request),
      conversationId,
      query,
    );
  }

  @Put('conversations/:conversationId/messages/:messageId/pin')
  @Header('Cache-Control', 'no-store')
  pin8(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.service.pin(
      requestCredentials(request),
      conversationId,
      messageId,
      body,
    );
  }

  @Post('conversations/:conversationId/forward')
  @Header('Cache-Control', 'no-store')
  forward9(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.forward(
      requestCredentials(request),
      conversationId,
      body,
    );
  }

  @Get('conversations/:conversationId/messages/:messageId/receipts')
  @Header('Cache-Control', 'no-store')
  receipts10(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.service.receipts(
      requestCredentials(request),
      conversationId,
      messageId,
    );
  }

  @Get('notifications')
  @Header('Cache-Control', 'no-store')
  notifications11(
    @Req() request: Request,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.notifications(requestCredentials(request), query);
  }

  @Put('notifications/:notificationId/read')
  @Header('Cache-Control', 'no-store')
  readNotification12(
    @Req() request: Request,
    @Param('notificationId') notificationId: string,
  ) {
    return this.service.readNotification(
      requestCredentials(request),
      notificationId,
    );
  }

  @Put('blocks/:userId')
  @Header('Cache-Control', 'no-store')
  block13(
    @Req() request: Request,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    return this.service.block(requestCredentials(request), userId, body);
  }

  @Post('reports')
  @Header('Cache-Control', 'no-store')
  report14(@Req() request: Request, @Body() body: unknown) {
    return this.service.report(requestCredentials(request), body);
  }
}
