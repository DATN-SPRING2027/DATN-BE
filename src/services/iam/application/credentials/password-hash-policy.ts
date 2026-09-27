import type { Options } from '@node-rs/argon2';

// @node-rs/argon2 publishes these API enums as ambient const enums, which are
// not directly consumable with this project's isolatedModules setting.
const ARGON2ID = 2 as NonNullable<Options['algorithm']>;
const ARGON2_VERSION_19 = 1 as NonNullable<Options['version']>;

/**
 * G-03 remains OPEN. These values implement the technical recommendation as
 * a provisional foundation only; deployment approval/benchmarking is pending.
 */
export const PROVISIONAL_PASSWORD_HASH_PROFILE = Object.freeze({
  algorithm: ARGON2ID,
  version: ARGON2_VERSION_19,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  saltLengthBytes: 16,
});

/**
 * Bound PHC work before invoking the native verifier. Lower-cost Argon2id
 * v19 hashes can be verified and marked for upgrade after successful proof;
 * higher-cost profiles require this policy/limit to be reviewed together.
 */
export const PASSWORD_HASH_VERIFICATION_LIMITS = Object.freeze({
  maxEncodedLength: 256,
  maxMemoryCost: PROVISIONAL_PASSWORD_HASH_PROFILE.memoryCost,
  maxTimeCost: PROVISIONAL_PASSWORD_HASH_PROFILE.timeCost,
  maxParallelism: PROVISIONAL_PASSWORD_HASH_PROFILE.parallelism,
});

export function createProvisionalPasswordHashOptions(
  salt: Uint8Array,
): Options {
  return {
    algorithm: PROVISIONAL_PASSWORD_HASH_PROFILE.algorithm,
    version: PROVISIONAL_PASSWORD_HASH_PROFILE.version,
    memoryCost: PROVISIONAL_PASSWORD_HASH_PROFILE.memoryCost,
    timeCost: PROVISIONAL_PASSWORD_HASH_PROFILE.timeCost,
    parallelism: PROVISIONAL_PASSWORD_HASH_PROFILE.parallelism,
    outputLen: PROVISIONAL_PASSWORD_HASH_PROFILE.outputLen,
    salt,
  };
}
