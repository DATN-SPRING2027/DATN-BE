import { monolithIamServiceUrl } from './monolith-configuration';
describe('legacy monolith IAM configuration', () => {
  it('uses the actual listening port for internal Chat authentication', () => {
    expect(monolithIamServiceUrl({ PORT: '3002' })).toBe(
      'http://127.0.0.1:3002',
    );
  });
  it('preserves an explicitly configured standalone IAM endpoint', () => {
    expect(
      monolithIamServiceUrl({
        PORT: '3002',
        IAM_SERVICE_URL: 'http://iam:3001',
      }),
    ).toBe('http://iam:3001');
  });
  it('uses the monolith default port when PORT is omitted', () => {
    expect(monolithIamServiceUrl({})).toBe('http://127.0.0.1:3001');
  });
});
