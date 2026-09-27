import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  parseOptions,
  verify as argon2Verify,
  type ParsedHashOptions,
} from '@node-rs/argon2';
import {
  PASSWORD_HASH_VERIFICATION_LIMITS,
  LEGACY_ARGON2_HASH_PROFILE,
} from './password-hash-policy';

const BCRYPT_ROUNDS = 12;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

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
    if (bcrypt.truncates(password)) {
      throw new PasswordHashFormatError('RESOURCE_LIMIT');
    }
    const encodedHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    if (
      !BCRYPT_HASH_PATTERN.test(encodedHash) ||
      bcrypt.getRounds(encodedHash) !== BCRYPT_ROUNDS
    ) {
      throw new Error('Generated password hash does not match the profile');
    }
    return encodedHash;
  }

  async verifyPassword(
    encodedHash: string,
    password: string,
  ): Promise<PasswordVerificationResult> {
    if (encodedHash.startsWith('$2')) {
      const match = BCRYPT_HASH_PATTERN.exec(encodedHash);
      if (!match) throw new PasswordHashFormatError('MALFORMED');
      const rounds = Number(match[1]);
      if (rounds > BCRYPT_ROUNDS)
        throw new PasswordHashFormatError('RESOURCE_LIMIT');
      if (rounds < 4) throw new PasswordHashFormatError('UNSUPPORTED');
      if (bcrypt.truncates(password))
        return { verified: false, needsRehash: false };
      const verified = await bcrypt.compare(password, encodedHash);
      return { verified, needsRehash: verified && rounds !== BCRYPT_ROUNDS };
    }

    this.parseSupportedHash(encodedHash);
    const verified = await argon2Verify(encodedHash, password);

    return {
      verified,
      // Long legacy passwords cannot be migrated without bcrypt truncation.
      needsRehash: verified && !bcrypt.truncates(password),
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
      parsed.algorithm !== LEGACY_ARGON2_HASH_PROFILE.algorithm ||
      parsed.version !== LEGACY_ARGON2_HASH_PROFILE.version ||
      parsed.outputLen !== LEGACY_ARGON2_HASH_PROFILE.outputLen ||
      parsed.saltLen !== LEGACY_ARGON2_HASH_PROFILE.saltLengthBytes
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
}
