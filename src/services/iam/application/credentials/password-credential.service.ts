import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  hash as argon2Hash,
  parseOptions,
  verify as argon2Verify,
  type ParsedHashOptions,
} from '@node-rs/argon2';
import {
  PASSWORD_HASH_VERIFICATION_LIMITS,
  PROVISIONAL_PASSWORD_HASH_PROFILE,
  createProvisionalPasswordHashOptions,
} from './password-hash-policy';

export type PasswordHashFormatFailure =
  'MALFORMED' | 'UNSUPPORTED' | 'RESOURCE_LIMIT';

export class PasswordHashFormatError extends Error {
  constructor(readonly reason: PasswordHashFormatFailure) {
    super(`Password hash is ${reason.toLowerCase()}`);
    this.name = PasswordHashFormatError.name;
  }
}

export interface PasswordVerificationResult {
  verified: boolean;
  needsRehash: boolean;
}

@Injectable()
export class PasswordCredentialService {
  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(PROVISIONAL_PASSWORD_HASH_PROFILE.saltLengthBytes);
    const encodedHash = await argon2Hash(
      password,
      createProvisionalPasswordHashOptions(salt),
    );

    // Fail closed if the selected native package ever stops honoring the
    // explicit PHC profile. Do not include password/hash material in errors.
    const parsed = this.parseSupportedHash(encodedHash);
    if (this.requiresRehash(parsed)) {
      throw new Error('Generated password hash does not match the profile');
    }

    return encodedHash;
  }

  async verifyPassword(
    encodedHash: string,
    password: string,
  ): Promise<PasswordVerificationResult> {
    const parsed = this.parseSupportedHash(encodedHash);
    const verified = await argon2Verify(encodedHash, password);

    return {
      verified,
      needsRehash: verified && this.requiresRehash(parsed),
    };
  }

  private parseSupportedHash(encodedHash: string): ParsedHashOptions {
    if (
      encodedHash.length === 0 ||
      encodedHash.length > PASSWORD_HASH_VERIFICATION_LIMITS.maxEncodedLength
    ) {
      throw new PasswordHashFormatError('MALFORMED');
    }

    let parsed: ParsedHashOptions;
    try {
      parsed = parseOptions(encodedHash);
    } catch {
      throw new PasswordHashFormatError('MALFORMED');
    }

    if (
      parsed.algorithm !== PROVISIONAL_PASSWORD_HASH_PROFILE.algorithm ||
      parsed.version !== PROVISIONAL_PASSWORD_HASH_PROFILE.version ||
      parsed.outputLen !== PROVISIONAL_PASSWORD_HASH_PROFILE.outputLen ||
      parsed.saltLen !== PROVISIONAL_PASSWORD_HASH_PROFILE.saltLengthBytes
    ) {
      throw new PasswordHashFormatError('UNSUPPORTED');
    }

    const validPositiveInteger = (value: number) =>
      Number.isSafeInteger(value) && value > 0;
    if (
      !validPositiveInteger(parsed.memoryCost) ||
      !validPositiveInteger(parsed.timeCost) ||
      !validPositiveInteger(parsed.parallelism) ||
      parsed.memoryCost < 8 * parsed.parallelism ||
      parsed.memoryCost > PASSWORD_HASH_VERIFICATION_LIMITS.maxMemoryCost ||
      parsed.timeCost > PASSWORD_HASH_VERIFICATION_LIMITS.maxTimeCost ||
      parsed.parallelism > PASSWORD_HASH_VERIFICATION_LIMITS.maxParallelism
    ) {
      throw new PasswordHashFormatError('RESOURCE_LIMIT');
    }

    return parsed;
  }

  private requiresRehash(parsed: ParsedHashOptions): boolean {
    return (
      parsed.algorithm !== PROVISIONAL_PASSWORD_HASH_PROFILE.algorithm ||
      parsed.version !== PROVISIONAL_PASSWORD_HASH_PROFILE.version ||
      parsed.memoryCost !== PROVISIONAL_PASSWORD_HASH_PROFILE.memoryCost ||
      parsed.timeCost !== PROVISIONAL_PASSWORD_HASH_PROFILE.timeCost ||
      parsed.parallelism !== PROVISIONAL_PASSWORD_HASH_PROFILE.parallelism ||
      parsed.outputLen !== PROVISIONAL_PASSWORD_HASH_PROFILE.outputLen ||
      parsed.saltLen !== PROVISIONAL_PASSWORD_HASH_PROFILE.saltLengthBytes
    );
  }
}
