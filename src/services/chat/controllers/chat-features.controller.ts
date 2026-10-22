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
import { ChatTrafficGuard } from './chat-traffic.guard';

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
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
    return this.service.draft(
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
      conversationId,
    );
  }

  @Put('conversations/:conversationId/draft')
  @Header('Cache-Control', 'no-store')
  draft3(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.service.draft(
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
      conversationId,
      userId,
      body,
    );
  }

  @Get('messages/search')
  @Header('Cache-Control', 'no-store')
  search6(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.service.search(
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
      query,
    );
  }

  @Get('conversations/:conversationId/library')
  @Header('Cache-Control', 'no-store')
  library7(
    @Req() request: Request,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.library(
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
    return this.service.notifications(
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
      query,
    );
  }

  @Put('notifications/:notificationId/read')
  @Header('Cache-Control', 'no-store')
  readNotification12(
    @Req() request: Request,
    @Param('notificationId') notificationId: string,
  ) {
    return this.service.readNotification(
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
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
    return this.service.block(
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
      userId,
      body,
    );
  }

  @Post('reports')
  @Header('Cache-Control', 'no-store')
  report14(@Req() request: Request, @Body() body: unknown) {
    return this.service.report(
      {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      },
      body,
    );
  }
}
