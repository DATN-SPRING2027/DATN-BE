import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { ChatApplicationService } from '../application/chat.service';
import type { ChatRealtimeService } from '../application/chat-realtime.service';
import { ChatRealtimeGateway } from './chat-realtime.gateway';

describe('ChatRealtimeGateway allowed origins (Round 2 Defect 1)', () => {
  const makeClient = () => {
    const closeMock = jest.fn();
    return {
      client: { close: closeMock } as unknown as WebSocket,
      closeMock,
    };
  };

  const makeRequest = (origin: string): IncomingMessage =>
    ({
      headers: {
        origin,
      },
    }) as unknown as IncomingMessage;

  it('defaults to both http://localhost:3000 and http://127.0.0.1:3000 in non-production when CHAT_ALLOWED_ORIGINS is unset', async () => {
    const gateway = new ChatRealtimeGateway(
      new ConfigService({ NODE_ENV: 'development' }),
      {} as ChatApplicationService,
      {} as ChatRealtimeService,
    );

    // Allowed dev origins pass the origin check and proceed to the ticket check.
    const localhost = makeClient();
    await gateway.handleConnection(
      localhost.client,
      makeRequest('http://localhost:3000'),
    );
    expect(localhost.closeMock).toHaveBeenCalledWith(
      1008,
      'Realtime ticket required',
    );

    const loopback = makeClient();
    await gateway.handleConnection(
      loopback.client,
      makeRequest('http://127.0.0.1:3000'),
    );
    expect(loopback.closeMock).toHaveBeenCalledWith(
      1008,
      'Realtime ticket required',
    );

    // Unlisted external origins are still rejected immediately.
    const evil = makeClient();
    await gateway.handleConnection(
      evil.client,
      makeRequest('https://evil.example'),
    );
    expect(evil.closeMock).toHaveBeenCalledWith(1008, 'Origin not allowed');
  });

  it('fails closed in production when CHAT_ALLOWED_ORIGINS is unset', async () => {
    const gateway = new ChatRealtimeGateway(
      new ConfigService({ NODE_ENV: 'production' }),
      {} as ChatApplicationService,
      {} as ChatRealtimeService,
    );

    const loopback = makeClient();
    await gateway.handleConnection(
      loopback.client,
      makeRequest('http://127.0.0.1:3000'),
    );
    expect(loopback.closeMock).toHaveBeenCalledWith(1008, 'Origin not allowed');
  });

  it('honors explicit CHAT_ALLOWED_ORIGINS when configured', async () => {
    const gateway = new ChatRealtimeGateway(
      new ConfigService({
        NODE_ENV: 'production',
        CHAT_ALLOWED_ORIGINS: 'https://app.continuum.ai',
      }),
      {} as ChatApplicationService,
      {} as ChatRealtimeService,
    );

    const ok = makeClient();
    await gateway.handleConnection(
      ok.client,
      makeRequest('https://app.continuum.ai'),
    );
    expect(ok.closeMock).toHaveBeenCalledWith(1008, 'Realtime ticket required');

    const bad = makeClient();
    await gateway.handleConnection(
      bad.client,
      makeRequest('http://localhost:3000'),
    );
    expect(bad.closeMock).toHaveBeenCalledWith(1008, 'Origin not allowed');
  });
});
