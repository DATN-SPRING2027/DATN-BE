/** Explicit shared-target policy. No dotenv, implicit application URI or connection. */
export function sharedTarget(env, apply = false) {
  const uri = env.WORKNOTE_MIGRATION_URI;
  const host = env.WORKNOTE_MIGRATION_EXPECTED_HOST;
  if (!uri || !host)
    throw Error('An explicit migration URI and expected host are required');
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw Error('Invalid migration target');
  }
  const authority = uri.slice(uri.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (
    parsed.protocol !== 'mongodb+srv:' ||
    parsed.hostname !== host ||
    !/^[a-z0-9][a-z0-9.-]+\.mongodb\.net$/i.test(host) ||
    parsed.port ||
    authority.includes(',') ||
    parsed.hash ||
    parsed.pathname !== '/continuum_capture'
  )
    throw Error(
      'Migration target must match the explicit Atlas host and continuum_capture database',
    );
  for (const [key, value] of parsed.searchParams) {
    const k = key.toLowerCase(),
      v = value.toLowerCase();
    if (
      (['tls', 'ssl'].includes(k) && v !== 'true') ||
      ([
        'tlsinsecure',
        'tlsallowinvalidcertificates',
        'tlsallowinvalidhostnames',
      ].includes(k) &&
        v !== 'false')
    )
      throw Error('Insecure TLS migration target is forbidden');
  }
  if (
    apply &&
    env.WORKNOTE_MIGRATION_CONFIRM_TARGET !== `${host}/continuum_capture`
  )
    throw Error('Explicit apply target confirmation is required');
  if (
    apply &&
    (!env.WORKNOTE_MIGRATION_BACKUP_REFERENCE?.trim() ||
      env.WORKNOTE_MIGRATION_BACKUP_REFERENCE.trim().length > 300)
  )
    throw Error(
      'Operator backup reference is required; its existence must be verified separately',
    );
  return { uri, host, database: 'continuum_capture' };
}
