import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ConnectionStates } from 'mongoose';

@Controller('health')
export class TaskHealthController {
  constructor(
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  @Get('live')
  getLiveness(): { status: 'live' } {
    return { status: 'live' };
  }

  @Get('ready')
  getReadiness(): { status: 'ready' } {
    if (this.connection.readyState !== ConnectionStates.connected) {
      throw new ServiceUnavailableException({ status: 'not_ready' });
    }

    return { status: 'ready' };
  }
}
