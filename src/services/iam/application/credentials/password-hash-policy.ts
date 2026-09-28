import type { Options } from '@node-rs/argon2';

// @node-rs/argon2 publishes these API enums as ambient const enums, which are
// not directly consumable with this project's isolatedModules setting.
const ARGON2ID = 2 as NonNullable<Options['algorithm']>;
const ARGON2_VERSION_19 = 1 as NonNullable<Options['version']>;

/** Existing Argon2id hashes remain verifiable during the bcrypt transition. */
export const LEGACY_ARGON2_HASH_PROFILE = Object.freeze({
  algorithm: ARGON2ID,
  version: ARGON2_VERSION_19,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  saltLengthBytes: 16,
});

/**
 * Bound legacy PHC work before invoking the native verifier.
 */
export const PASSWORD_HASH_VERIFICATION_LIMITS = Object.freeze({
  maxEncodedLength: 256,
  maxMemoryCost: LEGACY_ARGON2_HASH_PROFILE.memoryCost,
  maxTimeCost: LEGACY_ARGON2_HASH_PROFILE.timeCost,
  maxParallelism: LEGACY_ARGON2_HASH_PROFILE.parallelism,
});
