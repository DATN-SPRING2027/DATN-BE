import { ServiceUnavailableException } from '@nestjs/common';
import { StructuredExceptionFilter } from './structured-exception.filter';

describe('StructuredExceptionFilter', () => {
  it('keeps retry response sanitized and supplies Retry-After for Team retries', () => {
    const json = jest.fn();
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json,
      getHeader: jest.fn(),
    };
    const request = { requestId: 'request-123' };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    };

    new StructuredExceptionFilter().catch(
      new ServiceUnavailableException({
        code: 'RETRY_LATER',
        message: 'Retry with the same key.',
        details: { internal: 'must not leak' },
      }),
      host as never,
    );

    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(response.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      code: 'RETRY_LATER',
      message: 'Retry with the same key.',
      details: {},
      requestId: 'request-123',
    });
  });
});
