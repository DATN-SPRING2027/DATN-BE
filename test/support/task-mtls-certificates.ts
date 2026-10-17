import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface GeneratedCertificate {
  cert: Buffer;
  key: Buffer;
}

export interface TaskMtlsCertificates {
  ca: Buffer;
  trustedClient: GeneratedCertificate;
  mismatchedIdentityClient: GeneratedCertificate;
  untrustedClient: GeneratedCertificate;
  server: GeneratedCertificate;
  mismatchedIdentityServer: GeneratedCertificate;
  untrustedServer: GeneratedCertificate;
  cleanup(): void;
}

export const TASK_TEST_SERVER_IDENTITY = 'task.test.invalid';
export const GATEWAY_TEST_CLIENT_IDENTITY = 'gateway.test.invalid';

export function findOpenSsl(): string | undefined {
  const candidates = [
    process.env.OPENSSL_BIN,
    'openssl',
    ...(process.platform === 'win32'
      ? [
          join(
            process.env.ProgramFiles ?? 'C:\\Program Files',
            'Git',
            'usr',
            'bin',
            'openssl.exe',
          ),
          join(
            process.env.LOCALAPPDATA ?? '',
            'Programs',
            'Git',
            'usr',
            'bin',
            'openssl.exe',
          ),
        ]
      : []),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next installed OpenSSL entry point.
    }
  }
  return undefined;
}

export function createTaskMtlsCertificates(
  openssl = findOpenSsl(),
): TaskMtlsCertificates {
  if (!openssl) throw new Error('OpenSSL CLI is unavailable');

  const directory = mkdtempSync(join(tmpdir(), 'datn-d04-mtls-'));
  const opensslConfig = join(directory, 'openssl.cnf');
  writeFileSync(opensslConfig, '# isolated test-only OpenSSL configuration\n', {
    mode: 0o600,
  });
  const runOpenSsl = (args: string[]) =>
    execFileSync(openssl, args, {
      cwd: directory,
      env: { ...process.env, OPENSSL_CONF: opensslConfig },
      stdio: 'ignore',
    });
  const caCert = join(directory, 'trusted-ca.pem');
  const caKey = join(directory, 'trusted-ca-key.pem');
  const rogueCaCert = join(directory, 'untrusted-ca.pem');
  const rogueCaKey = join(directory, 'untrusted-ca-key.pem');

  const createCa = (cert: string, key: string, commonName: string) =>
    runOpenSsl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '2',
      '-subj',
      `/CN=${commonName}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);

  try {
    createCa(caCert, caKey, 'DATN-D04-test-only-trusted-CA');
    createCa(rogueCaCert, rogueCaKey, 'DATN-D04-test-only-untrusted-CA');

    const createLeaf = (
      name: string,
      commonName: string,
      ca: { cert: string; key: string },
      extension: string,
    ): GeneratedCertificate => {
      const key = join(directory, `${name}-key.pem`);
      const request = join(directory, `${name}.csr`);
      const cert = join(directory, `${name}.pem`);
      const extensionPath = join(directory, `${name}.ext`);
      writeFileSync(extensionPath, extension, { mode: 0o600 });
      runOpenSsl([
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        request,
        '-subj',
        `/CN=${commonName}`,
      ]);
      runOpenSsl([
        'x509',
        '-req',
        '-in',
        request,
        '-CA',
        ca.cert,
        '-CAkey',
        ca.key,
        '-CAcreateserial',
        '-out',
        cert,
        '-days',
        '2',
        '-sha256',
        '-extfile',
        extensionPath,
      ]);
      return {
        cert: readFileSync(cert),
        key: readFileSync(key),
      };
    };

    const clientExtensions = (dnsName: string) =>
      [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=clientAuth',
        `subjectAltName=DNS:${dnsName}`,
        '',
      ].join('\n');
    const serverExtensions = (dnsName: string, includeLoopbackIp = true) =>
      [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=${includeLoopbackIp ? 'IP:127.0.0.1,' : ''}DNS:${dnsName}`,
        '',
      ].join('\n');

    return {
      ca: readFileSync(caCert),
      server: createLeaf(
        'task-server',
        TASK_TEST_SERVER_IDENTITY,
        { cert: caCert, key: caKey },
        serverExtensions(TASK_TEST_SERVER_IDENTITY),
      ),
      mismatchedIdentityServer: createLeaf(
        'wrong-task-server',
        'other-task.test.invalid',
        { cert: caCert, key: caKey },
        serverExtensions('other-task.test.invalid'),
      ),
      untrustedServer: createLeaf(
        'untrusted-task-server',
        TASK_TEST_SERVER_IDENTITY,
        { cert: rogueCaCert, key: rogueCaKey },
        serverExtensions(TASK_TEST_SERVER_IDENTITY),
      ),
      trustedClient: createLeaf(
        'gateway-client',
        GATEWAY_TEST_CLIENT_IDENTITY,
        { cert: caCert, key: caKey },
        clientExtensions(GATEWAY_TEST_CLIENT_IDENTITY),
      ),
      mismatchedIdentityClient: createLeaf(
        'wrong-identity-client',
        'other-service.test.invalid',
        { cert: caCert, key: caKey },
        clientExtensions('other-service.test.invalid'),
      ),
      untrustedClient: createLeaf(
        'untrusted-client',
        GATEWAY_TEST_CLIENT_IDENTITY,
        { cert: rogueCaCert, key: rogueCaKey },
        clientExtensions(GATEWAY_TEST_CLIENT_IDENTITY),
      ),
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
