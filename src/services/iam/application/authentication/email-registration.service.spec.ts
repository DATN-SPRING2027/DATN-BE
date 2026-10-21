import { ConfigService } from '@nestjs/config';
import type { AuthenticationRepositoryPort } from './authentication.repository';
import type { AuthSecurityStore } from './auth-security.store';
import { type EmailRegistrationOutboxStore } from './email-registration.store';
import { EmailRegistrationService } from './email-registration.service';
import { PasswordCredentialService } from '../credentials/password-credential.service';

describe('EmailRegistrationService', () => {
  it('keeps generic account verification links independent from Organization invitations', async () => {
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
    });

    const savedInput = saveEmailRegistrationRequest.mock.calls[0]?.[0];
    const verificationUrl = new URL(savedInput?.payload?.verificationUrl ?? '');
    expect(verificationUrl.pathname).toBe('/verify-email');
    expect(verificationUrl.searchParams.has('returnToInvitationId')).toBe(
      false,
    );
    expect(verificationUrl.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);
  });
});
