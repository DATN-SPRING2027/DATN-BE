import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { GatewayCaptureController } from './gateway-capture.controller';

describe('GatewayCaptureController Work Note forwarding', () => {
  afterEach(() => jest.restoreAllMocks());

  const config = {
    getOrThrow: (key: string) =>
      key === 'CAPTURE_SERVICE_URL'
        ? 'http://127.0.0.1:3102'
        : key === 'CAPTURE_FILE_TIMEOUT_MS'
          ? 120000
          : 5000,
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

  it('streams Project Document uploads and preserves file headers', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const controller = new GatewayCaptureController(config as never);
    const request = Object.assign(Readable.from([Buffer.from('%PDF-1.7')]), {
      method: 'PUT',
      path: '/api/v1/capture/projects/111111111111111111111111/documents/222222222222222222222222/file',
      originalUrl:
        '/api/v1/capture/projects/111111111111111111111111/documents/222222222222222222222222/file',
      headers: {
        'content-type': 'application/pdf',
        'x-file-name': 'design.pdf',
        authorization: 'Bearer test-token',
      },
    });
    const upstream = new globalThis.Response('{"id":"document"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(upstream);
    const responseState = createResponse();

    await controller.uploadDocumentFile(
      request as unknown as Request,
      responseState.response,
    );

    const [uploadUrl, uploadOptions] = fetchMock.mock.calls[0] ?? [];
    expect(uploadUrl).toEqual(
      new URL(
        'http://127.0.0.1:3102/internal/capture/projects/111111111111111111111111/documents/222222222222222222222222/file',
      ),
    );
    expect(uploadOptions?.method).toBe('PUT');
    expect(uploadOptions?.headers).toMatchObject({
      'content-type': 'application/pdf',
      'x-file-name': 'design.pdf',
      authorization: 'Bearer test-token',
    });
    expect(uploadOptions?.body).toBe(request);
    expect(Reflect.get(uploadOptions ?? {}, 'duplex')).toBe('half');
    expect(responseState.status).toHaveBeenCalledWith(200);
    expect(timeout).toHaveBeenCalledWith(120000);
  });

  it('forwards Task Note deletion and Project Document download metadata', async () => {
    const controller = new GatewayCaptureController(config as never);
    const upstream = new globalThis.Response('file bytes', {
      status: 200,
      headers: {
        'cache-control': 'private, no-store',
        'content-type': 'application/pdf',
        'content-disposition': "attachment; filename*=UTF-8''design.pdf",
      },
    });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(upstream);
    const responseState = createResponse();
    const request = {
      method: 'GET',
      originalUrl:
        '/api/v1/capture/projects/111111111111111111111111/documents/222222222222222222222222/file?version=2',
      headers: {},
    } as Request;

    await controller.downloadDocumentFile(request, responseState.response);

    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL(
        'http://127.0.0.1:3102/internal/capture/projects/111111111111111111111111/documents/222222222222222222222222/file?version=2',
      ),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(responseState.setHeader).toHaveBeenCalledWith(
      'content-disposition',
      "attachment; filename*=UTF-8''design.pdf",
    );

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new globalThis.Response(null, { status: 204 }));
    await controller.deleteTaskNote(
      {
        method: 'DELETE',
        originalUrl:
          '/api/v1/capture/projects/111111111111111111111111/tasks/333333333333333333333333/notes/222222222222222222222222',
        headers: {},
      } as Request,
      responseState.response,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL(
        'http://127.0.0.1:3102/internal/capture/projects/111111111111111111111111/tasks/333333333333333333333333/notes/222222222222222222222222',
      ),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('allocates at least 185s proxy timeout for AI agent messages and split assessments', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const controller = new GatewayCaptureController(config as never);
    jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new globalThis.Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const responseState = createResponse();

    await controller.agentMessage(
      {
        method: 'POST',
        originalUrl:
          '/api/v1/capture/projects/111111111111111111111111/work-note-drafts/f081a006-489c-4a50-a0df-a54567fdc01b/agent/messages',
        headers: { 'content-type': 'application/json' },
        body: { instruction: 'Clarify' },
      } as unknown as Request,
      responseState.response,
    );
    expect(timeout).toHaveBeenLastCalledWith(185_000);

    await controller.updateTaskAssessment(
      {
        method: 'POST',
        originalUrl:
          '/api/v1/capture/projects/111111111111111111111111/work-note-drafts/f081a006-489c-4a50-a0df-a54567fdc01b/agent/assessments/a1/replies',
        headers: { 'content-type': 'application/json' },
        body: { disposition: 'unknown' },
      } as unknown as Request,
      responseState.response,
    );
    expect(timeout).toHaveBeenLastCalledWith(185_000);
  });
});
