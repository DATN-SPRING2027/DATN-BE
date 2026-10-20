import { ConfigService } from '@nestjs/config';
import type { AuthenticationRepositoryPort } from './authentication.repository';
import type { AuthSecurityStore } from './auth-security.store';
import { type EmailRegistrationOutboxStore } from './email-registration.store';
import { EmailRegistrationService } from './email-registration.service';
import { PasswordCredentialService } from '../credentials/password-credential.service';

describe('EmailRegistrationService invitation continuation', () => {
  it('carries only the non-secret invitation ID through the verification email URL', async () => {
    const invitationId = '3123456789abcdef01234567';
    type SaveInput = Parameters<
      EmailRegistrationOutboxStore['saveEmailRegistrationRequest']
    >[0];
    const saveEmailRegistrationRequest = jest
      .fn<Promise<boolean>, [SaveInput]>()
      .mockResolvedValue(true);
    const repository = {
      findAccountByEmail: jest.fn().mockResolvedValue(null),
    } as unknown as AuthenticationRepositoryPort;
    const security = {
      consumeRateLimit: jest.fn().mockResolvedValue(true),
    } as unknown as AuthSecurityStore;
    const outbox = {
      assertReady: jest.fn().mockResolvedValue(undefined),
      saveEmailRegistrationRequest,
    } as unknown as EmailRegistrationOutboxStore;
    const service = new EmailRegistrationService(
      repository,
      security,
      outbox,
      {} as PasswordCredentialService,
      new ConfigService({ WEB_APP_URL: 'https://continuum.example.test' }),
    );

    await service.requestRegistration({
      fullName: 'Invitee',
      email: 'invitee@example.test',
      sourceIp: '127.0.0.1',
      returnToInvitationId: invitationId,
    });

    const savedInput = saveEmailRegistrationRequest.mock.calls[0]?.[0];
    expect(savedInput?.payload?.verificationUrl).toContain(
      `returnToInvitationId=${invitationId}`,
    );
  });
});
