import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { EmailRegistrationController } from './email-registration.controller';
import type { EmailRegistrationService } from '../application/authentication/email-registration.service';

describe('EmailRegistrationController', () => {
  it('rejects the legacy invitation continuation field on public registration', async () => {
    const requestRegistration = jest
      .fn()
      .mockResolvedValue({ status: 'accepted' });
    const registrations = {
      requestRegistration,
    } as unknown as EmailRegistrationService;
    const controller = new EmailRegistrationController(
      registrations,
      new ConfigService({}),
    );
    const response = { setHeader: jest.fn() } as unknown as Response;

    await expect(
      controller.requestRegistration(
        {
          fullName: 'Invitee',
          email: 'invitee@example.test',
          returnToInvitationId: '3123456789abcdef01234567',
        },
        {
          originalUrl: '/api/v1/auth/registrations',
          ip: '127.0.0.1',
          headers: {},
          socket: { remoteAddress: '127.0.0.1' },
        } as Request,
        response,
      ),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'VALIDATION_FAILED' },
    });
    expect(requestRegistration).not.toHaveBeenCalled();
  });
});
