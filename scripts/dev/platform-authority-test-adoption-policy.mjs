export const PLATFORM_AUTHORITY_ADOPTION_TARGET = 'operator@continuum.test';
export const PLATFORM_AUTHORITY_ADOPTION_HOST =
  'kimthang.mh3rrz2.mongodb.net';
export const PLATFORM_AUTHORITY_ADOPTION_IAM_DATABASE = 'continuum_iam';
export const PLATFORM_AUTHORITY_ADOPTION_AUDIT_DATABASE = 'continuum_audit';

const TEST_ONLY_MARKER = 'TEST_ONLY_ATLAS_DEV';
const ALLOWED_MONGODB_OPTIONS = new Set([
  'appname',
  'authsource',
  'retrywrites',
  'tls',
  'w',
]);

function policyError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function assertFixedDatabaseNames(iamDatabaseName, auditDatabaseName) {
  if (
    iamDatabaseName !== PLATFORM_AUTHORITY_ADOPTION_IAM_DATABASE ||
    auditDatabaseName !== PLATFORM_AUTHORITY_ADOPTION_AUDIT_DATABASE
  ) {
    throw policyError(
      'UNAPPROVED_DATABASE',
      'Platform authority adoption is restricted to the fixed IAM and audit databases.',
    );
  }
}

export function parseTestAdoptionArguments(args) {
  let targetEmail;
  let apply = false;
  let sawApply = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--target-email') {
      if (targetEmail !== undefined || index + 1 >= args.length) {
        throw policyError(
          'EXPLICIT_TARGET_REQUIRED',
          'Pass exactly one explicit --target-email value.',
        );
      }
      targetEmail = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--apply-test-only') {
      if (sawApply) {
        throw policyError(
          'UNSUPPORTED_ARGUMENT',
          'The TEST_ONLY apply flag may be passed only once.',
        );
      }
      sawApply = true;
      apply = true;
      continue;
    }
    throw policyError(
      'UNSUPPORTED_ARGUMENT',
      'The test-only command accepts only --target-email and --apply-test-only.',
    );
  }

  if (!targetEmail) {
    throw policyError(
      'EXPLICIT_TARGET_REQUIRED',
      'Pass --target-email operator@continuum.test explicitly.',
    );
  }
  if (targetEmail !== PLATFORM_AUTHORITY_ADOPTION_TARGET) {
    throw policyError(
      'UNAPPROVED_TARGET',
      'Only the explicitly approved test operator target is accepted.',
    );
  }

  return { targetEmail, apply };
}

function getMongoOption(searchParams, name) {
  for (const [key, value] of searchParams.entries()) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return null;
}

function validateMongoUri(uri) {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw policyError('MONGODB_URI_REQUIRED', 'MONGODB_URI is required.');
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw policyError('INVALID_MONGODB_URI', 'MONGODB_URI is invalid.');
  }

  if (
    parsed.protocol !== 'mongodb+srv:' ||
    parsed.hostname.toLowerCase() !== PLATFORM_AUTHORITY_ADOPTION_HOST
  ) {
    throw policyError(
      'UNAPPROVED_MONGODB_HOST',
      'Only the explicitly allowlisted Atlas development host is accepted.',
    );
  }
  if (!parsed.username || !parsed.password) {
    throw policyError(
      'MONGODB_CREDENTIALS_REQUIRED',
      'The approved Atlas connection must use database-user credentials.',
    );
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw policyError(
      'MONGODB_DATABASE_PATH_PROHIBITED',
      'Select the fixed database names in source; URI database paths are prohibited.',
    );
  }
  if (parsed.hash) {
    throw policyError(
      'UNSAFE_MONGODB_OPTIONS',
      'MongoDB URI fragments are prohibited.',
    );
  }

  const observedOptions = new Set();
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_MONGODB_OPTIONS.has(key.toLowerCase())) {
      throw policyError(
        'UNSAFE_MONGODB_OPTIONS',
        'The MongoDB URI contains an unsupported connection option.',
      );
    }
    const normalizedKey = key.toLowerCase();
    if (observedOptions.has(normalizedKey)) {
      throw policyError(
        'UNSAFE_MONGODB_OPTIONS',
        'Repeated MongoDB URI options are prohibited.',
      );
    }
    observedOptions.add(normalizedKey);
  }
  for (const tlsOption of ['tls', 'ssl']) {
    const value = getMongoOption(parsed.searchParams, tlsOption);
    if (value !== null && value.toLowerCase() !== 'true') {
      throw policyError(
        'UNSAFE_MONGODB_OPTIONS',
        'TLS must remain enabled for the approved Atlas connection.',
      );
    }
  }
  const retryWrites = getMongoOption(parsed.searchParams, 'retryWrites');
  const writeConcern = getMongoOption(parsed.searchParams, 'w');
  const authSource = getMongoOption(parsed.searchParams, 'authSource');
  const appName = getMongoOption(parsed.searchParams, 'appName');
  if (
    (retryWrites !== null && retryWrites.toLowerCase() !== 'true') ||
    (writeConcern !== null && writeConcern.toLowerCase() !== 'majority') ||
    (authSource !== null && authSource.toLowerCase() !== 'admin') ||
    (appName !== null && (appName.length === 0 || appName.length > 128))
  ) {
    throw policyError(
      'UNSAFE_MONGODB_OPTIONS',
      'The MongoDB URI contains a disallowed or unsafe connection option.',
    );
  }

  return parsed;
}

export function validateTestAdoptionEnvironment(environment) {
  const { NODE_ENV, DATN_DB_ENV, MONGODB_URI } = environment;
  if (
    !['development', 'test'].includes(NODE_ENV) ||
    DATN_DB_ENV !== NODE_ENV
  ) {
    throw policyError(
      'UNSAFE_ENVIRONMENT',
      'NODE_ENV and DATN_DB_ENV must both be development or both be test.',
    );
  }
  if (
    environment.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION !== TEST_ONLY_MARKER
  ) {
    throw policyError(
      'TEST_ONLY_MARKER_REQUIRED',
      'The explicit TEST_ONLY Atlas adoption marker is required.',
    );
  }

  const dotenvControlPresent = Object.keys(environment).some(
    (key) =>
      key === 'DOTENV_KEY' ||
      key.startsWith('DOTENV_CONFIG_') ||
      key === 'NODE_OPTIONS',
  );
  if (dotenvControlPresent) {
    throw policyError(
      'DOTENV_CONTROL_PROHIBITED',
      'Dotenv and Node preload controls are prohibited for this command.',
    );
  }

  validateMongoUri(MONGODB_URI);
  assertFixedDatabaseNames(
    PLATFORM_AUTHORITY_ADOPTION_IAM_DATABASE,
    PLATFORM_AUTHORITY_ADOPTION_AUDIT_DATABASE,
  );
  return {
    environment: NODE_ENV,
    host: PLATFORM_AUTHORITY_ADOPTION_HOST,
    iamDatabaseName: PLATFORM_AUTHORITY_ADOPTION_IAM_DATABASE,
    auditDatabaseName: PLATFORM_AUTHORITY_ADOPTION_AUDIT_DATABASE,
  };
}
