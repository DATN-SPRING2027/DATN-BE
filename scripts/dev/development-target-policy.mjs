const DEVELOPMENT_ENVIRONMENT = 'development';
const ALLOWED_MONGODB_SCHEMES = new Set(['mongodb:', 'mongodb+srv:']);

export function requireDevelopmentEnvironment(env) {
  if (
    env.DATN_DB_ENV !== DEVELOPMENT_ENVIRONMENT ||
    env.NODE_ENV !== DEVELOPMENT_ENVIRONMENT
  ) {
    throw new Error(
      'DATN_DB_ENV and NODE_ENV must both be exactly development for this command.',
    );
  }
}

export function parseDevelopmentMongoUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('MONGODB_URI must be a valid development MongoDB URI.');
  }

  if (!ALLOWED_MONGODB_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      'MONGODB_URI must use mongodb:// or mongodb+srv:// for development.',
    );
  }

  const authorityStart = uri.indexOf('://') + 3;
  const authority = uri.slice(authorityStart).split(/[/?#]/, 1)[0];
  const hosts = authority.slice(authority.lastIndexOf('@') + 1);
  if (!parsed.hostname || !hosts || hosts.includes(',')) {
    throw new Error('MONGODB_URI must identify exactly one development host.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === '0.0.0.0' || hostname === '::') {
    throw new Error('MONGODB_URI must not use an unspecified host address.');
  }

  if (!['', '/'].includes(parsed.pathname)) {
    throw new Error(
      'MONGODB_URI must not select a database; service-owned targets are selected by the seed plan.',
    );
  }

  if (parsed.protocol === 'mongodb+srv:') {
    const hostnameLabels = parsed.hostname.replace(/\.$/, '').split('.');
    if (
      parsed.port ||
      hostnameLabels.length < 3 ||
      hostnameLabels.some((label) => label.length === 0) ||
      !parsed.username ||
      !parsed.password
    ) {
      throw new Error(
        'Atlas development MONGODB_URI must use one DNS hostname and include database-user credentials.',
      );
    }

    const disablesTls = [...parsed.searchParams.entries()].some(
      ([name, value]) =>
        ['tls', 'ssl'].includes(name.toLowerCase()) &&
        ['false', '0', 'no'].includes(value.toLowerCase()),
    );
    if (disablesTls) {
      throw new Error('Atlas development MONGODB_URI must not disable TLS.');
    }
  }

  return {
    protocol: parsed.protocol,
    hostname,
  };
}
