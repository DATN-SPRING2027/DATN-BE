import { hash as argon2Hash, parseOptions } from '@node-rs/argon2';
import { PasswordCredentialService } from './password-credential.service';
import {
  PasswordHashFormatError,
  type PasswordHashFormatFailure,
} from './password-credential.service';
import { PROVISIONAL_PASSWORD_HASH_PROFILE } from './password-hash-policy';

describe('PasswordCredentialService', () => {
  const service = new PasswordCredentialService();

  it('creates a self-describing Argon2id v19 PHC using the provisional profile', async () => {
    const encodedHash = await service.hashPassword('fixture-password');
    const parsed = parseOptions(encodedHash);

    expect(encodedHash).toMatch(/^\$argon2id\$v=19\$/);
    expect(parsed).toMatchObject({
      algorithm: PROVISIONAL_PASSWORD_HASH_PROFILE.algorithm,
      version: PROVISIONAL_PASSWORD_HASH_PROFILE.version,
      memoryCost: PROVISIONAL_PASSWORD_HASH_PROFILE.memoryCost,
      timeCost: PROVISIONAL_PASSWORD_HASH_PROFILE.timeCost,
      parallelism: PROVISIONAL_PASSWORD_HASH_PROFILE.parallelism,
      outputLen: PROVISIONAL_PASSWORD_HASH_PROFILE.outputLen,
      saltLen: PROVISIONAL_PASSWORD_HASH_PROFILE.saltLengthBytes,
    });
  });

  it('uses a fresh random salt for each generated hash', async () => {
    const first = await service.hashPassword('same-password');
    const second = await service.hashPassword('same-password');

    expect(first).not.toBe(second);
    expect(first.split('$')[4]).not.toBe(second.split('$')[4]);
  });

  it('verifies correct and incorrect passwords without requesting rehash for the current profile', async () => {
    const encodedHash = await service.hashPassword('correct-password');

    await expect(
      service.verifyPassword(encodedHash, 'correct-password'),
    ).resolves.toEqual({ verified: true, needsRehash: false });
    await expect(
      service.verifyPassword(encodedHash, 'incorrect-password'),
    ).resolves.toEqual({ verified: false, needsRehash: false });
  });

  it('requests rehash only after a successful verification of a supported lower-cost PHC', async () => {
    const olderHash = await argon2Hash('correct-password', {
      algorithm: PROVISIONAL_PASSWORD_HASH_PROFILE.algorithm,
      version: PROVISIONAL_PASSWORD_HASH_PROFILE.version,
      memoryCost: 1_024,
      timeCost: 1,
      parallelism: 1,
      outputLen: 32,
      salt: Buffer.alloc(16, 7),
    });

    await expect(
      service.verifyPassword(olderHash, 'incorrect-password'),
    ).resolves.toEqual({ verified: false, needsRehash: false });
    await expect(
      service.verifyPassword(olderHash, 'correct-password'),
    ).resolves.toEqual({ verified: true, needsRehash: true });
  });

  it.each([
    ['malformed PHC', 'not-a-phc', 'MALFORMED'],
    [
      'unsupported Argon2 variant',
      `$argon2i$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
      'UNSUPPORTED',
    ],
    [
      'unsupported Argon2 version',
      `$argon2id$v=16$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`,
      'UNSUPPORTED',
    ],
  ] as const)(
    'rejects %s explicitly before verification',
    async (_label, encodedHash, reason: PasswordHashFormatFailure) => {
      await expect(
        service.verifyPassword(encodedHash, 'fixture-password'),
      ).rejects.toMatchObject<Partial<PasswordHashFormatError>>({ reason });
    },
  );

  it('rejects a valid PHC whose work factor exceeds the provisional verifier bound', async () => {
    const aboveBoundHash = await argon2Hash('fixture-password', {
      algorithm: PROVISIONAL_PASSWORD_HASH_PROFILE.algorithm,
      version: PROVISIONAL_PASSWORD_HASH_PROFILE.version,
      memoryCost: PROVISIONAL_PASSWORD_HASH_PROFILE.memoryCost + 1,
      timeCost: PROVISIONAL_PASSWORD_HASH_PROFILE.timeCost,
      parallelism: PROVISIONAL_PASSWORD_HASH_PROFILE.parallelism,
      outputLen: PROVISIONAL_PASSWORD_HASH_PROFILE.outputLen,
      salt: Buffer.alloc(16, 9),
    });

    await expect(
      service.verifyPassword(aboveBoundHash, 'fixture-password'),
    ).rejects.toMatchObject<Partial<PasswordHashFormatError>>({
      reason: 'RESOURCE_LIMIT',
    });
  });

  it('rejects PHC strings beyond the parser input bound', async () => {
    await expect(
      service.verifyPassword('x'.repeat(257), 'fixture-password'),
    ).rejects.toMatchObject({ reason: 'MALFORMED' });
  });
});
