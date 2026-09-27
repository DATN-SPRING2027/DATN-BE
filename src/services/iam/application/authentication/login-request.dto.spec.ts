import { validateSync } from 'class-validator';
import { LoginRequestDto } from './login-request.dto';

describe('LoginRequestDto', () => {
  it('accepts an email and non-empty password within the specified bounds', () => {
    const input = Object.assign(new LoginRequestDto(), {
      email: 'person@example.com',
      password: 'a'.repeat(1024),
      organizationId: '651a2b3c4d5e6f7a8b9c0d1e',
    });

    expect(validateSync(input)).toHaveLength(0);
  });

  it('rejects malformed email and empty or oversized password input', () => {
    const malformedEmail = Object.assign(new LoginRequestDto(), {
      email: 'not-an-email',
      password: 'password',
    });
    const emptyPassword = Object.assign(new LoginRequestDto(), {
      email: 'person@example.com',
      password: '',
    });
    const oversizedPassword = Object.assign(new LoginRequestDto(), {
      email: 'person@example.com',
      password: 'a'.repeat(1025),
    });
    const malformedOrganization = Object.assign(new LoginRequestDto(), {
      email: 'person@example.com',
      password: 'password',
      organizationId: 'not-an-object-id',
    });

    expect(validateSync(malformedEmail).length).toBeGreaterThan(0);
    expect(validateSync(emptyPassword).length).toBeGreaterThan(0);
    expect(validateSync(oversizedPassword).length).toBeGreaterThan(0);
    expect(validateSync(malformedOrganization).length).toBeGreaterThan(0);
  });

  it('rejects an email longer than the documented maximum', () => {
    const input = Object.assign(new LoginRequestDto(), {
      email: `${'a'.repeat(309)}@example.com`,
      password: 'password',
    });

    expect(validateSync(input).length).toBeGreaterThan(0);
  });
});
