import { BadRequestException } from '@nestjs/common';
import { PlatformAuthorityLegacyAdoptionService } from './platform-authority-legacy-adoption.service';
import type { PlatformAuthorityLegacyAdoptionRepository } from './platform-authority-legacy-adoption.repository';

describe('PlatformAuthorityLegacyAdoptionService', () => {
  let service: PlatformAuthorityLegacyAdoptionService;
  let repository: jest.Mocked<PlatformAuthorityLegacyAdoptionRepository>;
  let priorEnvironment: Record<string, string | undefined>;

  beforeEach(() => {
    priorEnvironment = {
      NODE_ENV: process.env.NODE_ENV,
      DATN_DB_ENV: process.env.DATN_DB_ENV,
      DATN_TEST_PLATFORM_AUTHORITY_ADOPTION:
        process.env.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION,
    };
    process.env.NODE_ENV = 'test';
    process.env.DATN_DB_ENV = 'test';
    process.env.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION = 'TEST_ONLY_ATLAS_DEV';
    repository = {
      inspect: jest.fn(),
      adopt: jest.fn(),
    };
    service = new PlatformAuthorityLegacyAdoptionService(repository);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('validates the fixed adoption command before invoking the repository', async () => {
    const command = {
      operationId: '00000000-0000-4000-8000-000000000301',
      actorUserId: '64b000000000000000000002',
      issuerUserId: '64b000000000000000000003',
      expectedCurrentSnapshotHash: 'a'.repeat(64),
    };
    repository.adopt.mockResolvedValue({
      operationId: command.operationId,
      status: 'COMMITTED',
      httpStatus: 200,
      replayed: false,
      body: {
        operationId: command.operationId,
        targetUserId: '64b000000000000000000001',
        scope: 'PLATFORM',
        status: 'ACTIVE',
        assignments: [],
      },
    });

    await expect(service.adopt(command)).resolves.toMatchObject({
      operationId: command.operationId,
      replayed: false,
    });
    expect(repository.adopt.mock.calls).toEqual([[command]]);
  });

  it.each([
    ['permissions', ['platform.users.account.manage']],
    ['bundleVersion', 'V2'],
    ['scope', 'PLATFORM'],
    ['targetEmail', 'operator@continuum.test'],
  ])(
    'rejects caller supplied %s instead of accepting only fixed policy',
    async (field, value) => {
      await expect(
        service.adopt({
          operationId: '00000000-0000-4000-8000-000000000302',
          actorUserId: '64b000000000000000000002',
          issuerUserId: '64b000000000000000000003',
          expectedCurrentSnapshotHash: 'b'.repeat(64),
          [field]: value,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.adopt.mock.calls).toHaveLength(0);
    },
  );

  it('rejects malformed idempotency and stale-snapshot inputs', async () => {
    await expect(
      service.adopt({
        operationId: 'not-a-uuid',
        actorUserId: '64b000000000000000000002',
        issuerUserId: '64b000000000000000000003',
        expectedCurrentSnapshotHash: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_OPERATION_ID' } });
    await expect(
      service.adopt({
        operationId: '00000000-0000-4000-8000-000000000303',
        actorUserId: '64b000000000000000000002',
        issuerUserId: '64b000000000000000000003',
        expectedCurrentSnapshotHash: 'bad-hash',
      }),
    ).rejects.toMatchObject({
      response: { code: 'EXPECTED_SNAPSHOT_REQUIRED' },
    });
    expect(repository.adopt.mock.calls).toHaveLength(0);
  });

  it('rejects identical actor and issuer fixtures', async () => {
    await expect(
      service.adopt({
        operationId: '00000000-0000-4000-8000-000000000304',
        actorUserId: '64b000000000000000000002',
        issuerUserId: '64b000000000000000000002',
        expectedCurrentSnapshotHash: 'c'.repeat(64),
      }),
    ).rejects.toMatchObject({
      response: { code: 'TWO_PERSON_RULE_VIOLATION' },
    });
    expect(repository.adopt.mock.calls).toHaveLength(0);
  });

  it('fails closed unless both environment labels and the TEST_ONLY marker match', async () => {
    process.env.NODE_ENV = 'production';
    await expect(service.inspect()).rejects.toMatchObject({
      response: { code: 'TEST_ONLY_ADOPTION_DISABLED' },
    });

    process.env.NODE_ENV = 'test';
    delete process.env.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION;
    await expect(
      service.adopt({
        operationId: '00000000-0000-4000-8000-000000000305',
        actorUserId: '64b000000000000000000002',
        issuerUserId: '64b000000000000000000003',
        expectedCurrentSnapshotHash: 'd'.repeat(64),
      }),
    ).rejects.toMatchObject({
      response: { code: 'TEST_ONLY_ADOPTION_DISABLED' },
    });
    expect(repository.inspect.mock.calls).toHaveLength(0);
    expect(repository.adopt.mock.calls).toHaveLength(0);
  });
});
