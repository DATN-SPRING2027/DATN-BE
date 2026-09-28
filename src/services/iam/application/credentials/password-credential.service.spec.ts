import { hash as argon2Hash } from '@node-rs/argon2';
import * as bcrypt from 'bcryptjs';
import { PasswordCredentialService } from './password-credential.service';
import {
  PasswordHashFormatError,
  type PasswordHashFormatFailure,
} from './password-credential.service';
import { LEGACY_ARGON2_HASH_PROFILE } from './password-hash-policy';

describe('PasswordCredentialService', () => {
  const service = new PasswordCredentialService();

  it('creates a bcrypt hash with the documented 12-round cost', async () => {
    const encodedHash = await service.hashPassword('fixture-password');
    expect(encodedHash).toMatch(/^\$2b\$12\$/);
    expect(bcrypt.getRounds(encodedHash)).toBe(12);
  });

  it('uses a fresh random salt for each generated hash', async () => {
    const first = await service.hashPassword('same-password');
    const second = await service.hashPassword('same-password');

    expect(first).not.toBe(second);
    expect(first.split('$')[3]).not.toBe(second.split('$')[3]);
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

  it('accepts a legacy Argon2id hash and requests bcrypt migration after successful verification', async () => {
    const olderHash = await argon2Hash('correct-password', {
      algorithm: LEGACY_ARGON2_HASH_PROFILE.algorithm,
      version: LEGACY_ARGON2_HASH_PROFILE.version,
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

  it('keeps long legacy passwords valid without truncating them into bcrypt', async () => {
    const longPassword = 'é'.repeat(37);
    const oldHash = await argon2Hash(longPassword, {
      algorithm: LEGACY_ARGON2_HASH_PROFILE.algorithm,
      version: LEGACY_ARGON2_HASH_PROFILE.version,
      memoryCost: LEGACY_ARGON2_HASH_PROFILE.memoryCost,
      timeCost: LEGACY_ARGON2_HASH_PROFILE.timeCost,
      parallelism: LEGACY_ARGON2_HASH_PROFILE.parallelism,
      outputLen: LEGACY_ARGON2_HASH_PROFILE.outputLen,
      salt: Buffer.alloc(16, 5),
    });

    await expect(
      service.verifyPassword(oldHash, longPassword),
    ).resolves.toEqual({
      verified: true,
      needsRehash: false,
    });
  });

  it('marks an older bcrypt cost for upgrade only after correct verification', async () => {
    const oldHash = await bcrypt.hash('correct-password', 10);
    await expect(
      service.verifyPassword(oldHash, 'wrong-password'),
    ).resolves.toEqual({
      verified: false,
      needsRehash: false,
    });
    await expect(
      service.verifyPassword(oldHash, 'correct-password'),
    ).resolves.toEqual({
      verified: true,
      needsRehash: true,
    });
  });

  it('does not silently truncate passwords beyond bcrypt’s 72-byte input limit', async () => {
    await expect(service.hashPassword('é'.repeat(37))).rejects.toMatchObject({
      reason: 'RESOURCE_LIMIT',
    });
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
      algorithm: LEGACY_ARGON2_HASH_PROFILE.algorithm,
      version: LEGACY_ARGON2_HASH_PROFILE.version,
      memoryCost: LEGACY_ARGON2_HASH_PROFILE.memoryCost + 1,
      timeCost: LEGACY_ARGON2_HASH_PROFILE.timeCost,
      parallelism: LEGACY_ARGON2_HASH_PROFILE.parallelism,
      outputLen: LEGACY_ARGON2_HASH_PROFILE.outputLen,
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
