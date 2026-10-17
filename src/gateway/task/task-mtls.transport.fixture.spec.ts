import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from 'node:https';
import type { AddressInfo } from 'node:net';
import type { ServerOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import {
  createTaskMtlsCertificates,
  findOpenSsl,
  GATEWAY_TEST_CLIENT_IDENTITY,
  type TaskMtlsCertificates,
} from '../../../test/support/task-mtls-certificates';

const openssl = findOpenSsl();
const describeWithOpenSsl = openssl ? describe : describe.skip;

interface RunningFixture {
  endpoint: string;
  protectedOperationCalls: number;
  close(): Promise<void>;
}

async function startMutualTlsFixture(
  certificates: TaskMtlsCertificates,
): Promise<RunningFixture> {
  let protectedOperationCalls = 0;
  const options: ServerOptions = {
    key: certificates.server.key,
    cert: certificates.server.cert,
    ca: certificates.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
  const server = createHttpsServer(options, (_request, response) => {
    const socket = response.socket as TLSSocket;
    const peerCertificate = socket.getPeerCertificate();
    if (!socket.authorized || !peerCertificate.raw) {
      response.writeHead(401).end();
      return;
    }

    const peer = new X509Certificate(peerCertificate.raw);
    // This fixture demonstrates one exact-SAN mapping; it does not select the
    // production service-identity namespace or certificate policy.
    if (peer.subjectAltName !== `DNS:${GATEWAY_TEST_CLIENT_IDENTITY}`) {
      response.writeHead(403).end();
      return;
    }

    protectedOperationCalls += 1;
    response.writeHead(204).end();
  });
  server.on('tlsClientError', () => {
    // Intentionally do not expose TLS error details from the fixture.
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    endpoint: `https://127.0.0.1:${address.port}`,
    get protectedOperationCalls() {
      return protectedOperationCalls;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function sendFixtureRequest(
  endpoint: string,
  certificates: TaskMtlsCertificates,
  client?: TaskMtlsCertificates['trustedClient'],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      endpoint,
      {
        ca: certificates.ca,
        ...(client ? { cert: client.cert, key: client.key } : {}),
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.once('error', reject);
    request.end();
  });
}

describeWithOpenSsl('test-only standalone mutual TLS boundary fixture', () => {
  let certificates: TaskMtlsCertificates;

  beforeAll(() => {
    certificates = createTaskMtlsCertificates(openssl);
  });

  afterAll(() => {
    certificates?.cleanup();
  });

  it('accepts a trusted client certificate with the expected SAN identity', async () => {
    const fixture = await startMutualTlsFixture(certificates);
    try {
      await expect(
        sendFixtureRequest(
          fixture.endpoint,
          certificates,
          certificates.trustedClient,
        ),
      ).resolves.toBe(204);
      expect(fixture.protectedOperationCalls).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('rejects an untrusted client certificate during the TLS handshake', async () => {
    const fixture = await startMutualTlsFixture(certificates);
    try {
      await expect(
        sendFixtureRequest(
          fixture.endpoint,
          certificates,
          certificates.untrustedClient,
        ),
      ).rejects.toBeDefined();
      expect(fixture.protectedOperationCalls).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('rejects a missing client certificate during the TLS handshake', async () => {
    const fixture = await startMutualTlsFixture(certificates);
    try {
      await expect(
        sendFixtureRequest(fixture.endpoint, certificates),
      ).rejects.toBeDefined();
      expect(fixture.protectedOperationCalls).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('rejects a trusted client certificate with a mismatched SAN identity', async () => {
    const fixture = await startMutualTlsFixture(certificates);
    try {
      await expect(
        sendFixtureRequest(
          fixture.endpoint,
          certificates,
          certificates.mismatchedIdentityClient,
        ),
      ).resolves.toBe(403);
      expect(fixture.protectedOperationCalls).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
