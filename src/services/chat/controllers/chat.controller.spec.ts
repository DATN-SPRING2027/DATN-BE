import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { Request, Response } from 'express';
import type { ChatApplicationService } from '../application/chat.service';
import { ChatController } from './chat.controller';

describe('ChatController streaming download & multi-org headers', () => {
  it('streams attachment bytes with safe download headers (BE-DATA-002 / SEC-BE-002 / SEC-BE-005)', async () => {
    const payload = Buffer.from('%PDF-1.7 confidential stream');
    const getAttachmentStream = jest.fn().mockResolvedValue({
      stream: Readable.from([payload]),
      size: payload.length,
      contentType: 'application/octet-stream',
      filename: 'quarterly report.pdf',
    });
    const service = {
      getAttachmentStream,
    } as unknown as ChatApplicationService;
    const controller = new ChatController(service);

    const headers = new Map<string, string>();
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve) => sink.on('finish', resolve));

    const response = Object.assign(sink, {
      headersSent: false,
      setHeader: jest.fn((name: string, value: string) => {
        headers.set(name.toLowerCase(), value);
      }),
      status: jest.fn().mockReturnThis(),
    }) as unknown as Response;

    const request = Object.assign(new EventEmitter(), {
      headers: {
        authorization: 'Bearer token',
        'x-organization-id': '507f1f77bcf86cd799439011',
        'x-expected-organization-id': '507f1f77bcf86cd799439011',
      },
    }) as unknown as Request;

    await controller.downloadAttachmentContent(
      request,
      '507f1f77bcf86cd799439013',
      '11234567-89ab-4cde-8fab-0123456789ab',
      response,
    );
    await done;

    expect(getAttachmentStream).toHaveBeenCalledWith(
      {
        authorization: 'Bearer token',
        organizationId: '507f1f77bcf86cd799439011',
        expectedOrganizationId: '507f1f77bcf86cd799439011',
      },
      '507f1f77bcf86cd799439013',
      '11234567-89ab-4cde-8fab-0123456789ab',
    );
    expect(headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''quarterly%20report.pdf",
    );
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('content-security-policy')).toBe('sandbox');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('content-length')).toBe(String(payload.length));
    expect(Buffer.concat(chunks)).toEqual(payload);
  });
});
