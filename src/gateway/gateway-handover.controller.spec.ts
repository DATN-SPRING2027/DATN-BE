import {
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { GatewayHandoverController } from './gateway-handover.controller';

describe('GatewayHandoverController forwarding', () => {
  afterEach(() => jest.restoreAllMocks());

  const config = {
    getOrThrow: (key: string) =>
      key === 'HANDOVER_SERVICE_URL' ? 'http://127.0.0.1:3106' : 5000,
  };

  function createResponse() {
    const setHeader = jest.fn();
    const status = jest.fn().mockReturnThis();
    const send = jest.fn().mockReturnThis();
    return {
      response: { setHeader, status, send } as unknown as Response,
      setHeader,
      status,
      send,
    };
  }

  it('forwards mutation headers and preserves ETag, Cache-Control, and Idempotency-Replayed headers', async () => {
    const controller = new GatewayHandoverController(config as never);
    const upstream = new globalThis.Response(
      JSON.stringify({
        operationId: '550e8400-e29b-41d4-a716-446655440000',
        handoverId: '222222222222222222222222',
        version: 2,
        status: 'OPEN',
        revisionId: '333333333333333333333333',
        replayed: true,
      }),
      {
        status: 201,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json',
          etag: '"handover:222222222222222222222222:2"',
          'idempotency-replayed': 'true',
        },
      },
    );
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(upstream);
    const responseState = createResponse();

    await controller.publishHandoverRevision(
      {
        method: 'POST',
        originalUrl:
          '/api/v1/handover/projects/111111111111111111111111/handovers/222222222222222222222222/revisions',
        headers: {
          'content-type': 'application/json',
          cookie: 'continuum_access=jwt; continuum_csrf=csrf123',
          'x-csrf-token': 'csrf123',
          'idempotency-key': '550e8400-e29b-41d4-a716-446655440000',
          'if-match': '"handover:222222222222222222222222:1"',
          'x-organization-id': '444444444444444444444444',
        },
        body: {
          expectedDraftVersion: 1,
          itemReviews: [],
          gapAssignments: [],
          reviewNote: 'ok',
        },
      } as unknown as Request,
      responseState.response,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL(
        'http://127.0.0.1:3106/internal/handover/projects/111111111111111111111111/handovers/222222222222222222222222/revisions',
      ),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'content-type': 'application/json',
      cookie: 'continuum_access=jwt; continuum_csrf=csrf123',
      'x-csrf-token': 'csrf123',
      'idempotency-key': '550e8400-e29b-41d4-a716-446655440000',
      'if-match': '"handover:222222222222222222222222:1"',
      'x-organization-id': '444444444444444444444444',
    });
    expect(responseState.setHeader).toHaveBeenCalledWith(
      'etag',
      '"handover:222222222222222222222222:2"',
    );
    expect(responseState.setHeader).toHaveBeenCalledWith(
      'idempotency-replayed',
      'true',
    );
    expect(responseState.status).toHaveBeenCalledWith(201);
  });

  it('maps upstream TimeoutError to 504 and network errors to 503', async () => {
    const controller = new GatewayHandoverController(config as never);
    const responseState = createResponse();
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError';

    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(timeoutErr);
    await expect(
      controller.listHandovers(
        {
          method: 'GET',
          originalUrl:
            '/api/v1/handover/projects/111111111111111111111111/handovers',
          headers: {},
        } as Request,
        responseState.response,
      ),
    ).rejects.toThrow(GatewayTimeoutException);

    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(
      controller.listHandovers(
        {
          method: 'GET',
          originalUrl:
            '/api/v1/handover/projects/111111111111111111111111/handovers',
          headers: {},
        } as Request,
        responseState.response,
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
