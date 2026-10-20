import { isIP } from 'node:net';
import { TASK_DATABASE_NAME } from '../infrastructure/mongodb/task-contract';

export interface TaskRuntimeConfig {
  mongoUri: string;
  port: number;
  /**
   * Registers the Task list and detail routes only when TASK_ROUTES_ENABLED is
   * exactly `true`. It never bypasses the entrypoint gates above, and every
   * route still passes the deny-by-default authorization boundary.
   */
  routesEnabled?: boolean;
}

const MIN_TASK_PORT = 1024;
const MAX_TASK_PORT = 65535;

function validateLoopbackHosts(authority: string): void {
  const hostList = authority.slice(authority.lastIndexOf('@') + 1);
  const hosts = hostList.split(',');
  if (hosts.length === 0) {
    throw new Error('TASK_MONGODB_URI must contain a loopback host');
  }

  for (const hostAndPort of hosts) {
    let hostname: string;
    let portText: string | undefined;
    if (hostAndPort.startsWith('[')) {
      const closingBracket = hostAndPort.indexOf(']');
      if (closingBracket < 0) {
        throw new Error('TASK_MONGODB_URI contains an invalid host');
      }
      hostname = hostAndPort.slice(1, closingBracket);
      const portSuffix = hostAndPort.slice(closingBracket + 1);
      if (portSuffix) {
        if (!/^:\d+$/.test(portSuffix)) {
          throw new Error('TASK_MONGODB_URI contains an invalid port');
        }
        portText = portSuffix.slice(1);
      }
    } else {
      const colon = hostAndPort.lastIndexOf(':');
      if (colon >= 0) {
        hostname = hostAndPort.slice(0, colon);
        portText = hostAndPort.slice(colon + 1);
        if (!/^\d+$/.test(portText)) {
          throw new Error('TASK_MONGODB_URI contains an invalid port');
        }
      } else {
        hostname = hostAndPort;
      }
    }

    const normalizedHostname = hostname.toLowerCase();
    const isLoopback =
      normalizedHostname === 'localhost' ||
      normalizedHostname === '::1' ||
      (isIP(normalizedHostname) === 4 && normalizedHostname.startsWith('127.'));
    if (!isLoopback) {
      throw new Error(
        'TASK_MONGODB_URI must use loopback hosts for dormant runtime',
      );
    }

    if (portText) {
      const port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('TASK_MONGODB_URI contains an invalid port');
      }
    }
  }
}

function validateMongoUri(value: string): void {
  const match = value.match(/^mongodb:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/i);
  if (!match) {
    throw new Error(
      'TASK_MONGODB_URI must be a valid mongodb:// URI with loopback hosts',
    );
  }
  const authority = match[1];
  validateLoopbackHosts(authority);

  let databaseName: string;
  try {
    databaseName = decodeURIComponent((match[2] ?? '').replace(/^\/|\/$/g, ''));
  } catch {
    throw new Error('TASK_MONGODB_URI contains an invalid database path');
  }

  if (databaseName && databaseName !== TASK_DATABASE_NAME) {
    throw new Error('TASK_MONGODB_URI must select continuum_task only');
  }
}

export function createTaskRuntimeConfig(
  environment: NodeJS.ProcessEnv,
): TaskRuntimeConfig {
  if (
    environment.NODE_ENV !== 'development' &&
    environment.NODE_ENV !== 'test'
  ) {
    throw new Error('Task runtime is restricted to development and test');
  }

  if (environment.TASK_RUNTIME_ENABLED !== 'true') {
    throw new Error('TASK_RUNTIME_ENABLED must be true');
  }

  const mongoUri = environment.TASK_MONGODB_URI;
  if (!mongoUri) {
    throw new Error('TASK_MONGODB_URI is required');
  }
  validateMongoUri(mongoUri);

  const portText = environment.TASK_SERVICE_PORT;
  if (!portText || !/^\d+$/.test(portText)) {
    throw new Error('TASK_SERVICE_PORT must be an integer from 1024 to 65535');
  }

  const port = Number(portText);
  if (
    !Number.isSafeInteger(port) ||
    port < MIN_TASK_PORT ||
    port > MAX_TASK_PORT
  ) {
    throw new Error('TASK_SERVICE_PORT must be an integer from 1024 to 65535');
  }

  return {
    mongoUri,
    port,
    routesEnabled: environment.TASK_ROUTES_ENABLED === 'true',
  };
}
