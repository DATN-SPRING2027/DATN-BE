import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PLATFORM_SERVICE_IDS,
  type PlatformDependencyState,
  type PlatformServiceId,
  type PlatformServiceOperationsRepository,
  type PlatformServiceOperationsSummary,
  type PlatformServiceState,
} from '../../application/platform/platform-service-operations.repository';

const probeTimeoutMs = 2_000;

const serviceDefinitions: Record<
  PlatformServiceId,
  { name: string; configKey: string; defaultUrl: string }
> = {
  iam: {
    name: 'Identity and Access Management',
    configKey: 'IAM_SERVICE_URL',
    defaultUrl: 'http://127.0.0.1:3001',
  },
  capture: {
    name: 'Capture',
    configKey: 'CAPTURE_SERVICE_URL',
    defaultUrl: 'http://127.0.0.1:3002',
  },
  jira: {
    name: 'Jira Integration',
    configKey: 'JIRA_SERVICE_URL',
    defaultUrl: 'http://127.0.0.1:3003',
  },
  lifecycle: {
    name: 'Lifecycle',
    configKey: 'LIFECYCLE_SERVICE_URL',
    defaultUrl: 'http://127.0.0.1:3004',
  },
  chat: {
    name: 'Chat',
    configKey: 'CHAT_SERVICE_URL',
    defaultUrl: 'http://127.0.0.1:3005',
  },
  handover: {
    name: 'Handover',
    configKey: 'HANDOVER_SERVICE_URL',
    defaultUrl: 'http://127.0.0.1:3006',
  },
  ingestion: {
    name: 'Ingestion',
    configKey: 'INGESTION_SERVICE_URL',
    defaultUrl: 'http://127.0.0.1:3007',
  },
  notification: {
    name: 'Notification',
    configKey: 'NOTIFICATION_SERVICE_URL',
    defaultUrl: 'http://127.0.0.1:3008',
  },
};

type ReadinessPayload = {
  status: PlatformServiceState;
  liveness: 'ALIVE';
  dependencies: {
    mongodb: PlatformDependencyState;
    redis: PlatformDependencyState;
  };
};

function parseReadinessPayload(value: unknown): ReadinessPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  const dependencies = payload.dependencies;
  if (
    !['READY', 'DEGRADED', 'UNAVAILABLE'].includes(String(payload.status)) ||
    payload.liveness !== 'ALIVE' ||
    typeof dependencies !== 'object' ||
    dependencies === null ||
    Array.isArray(dependencies)
  ) {
    return null;
  }
  const values = dependencies as Record<string, unknown>;
  if (
    !['AVAILABLE', 'UNAVAILABLE'].includes(String(values.mongodb)) ||
    !['AVAILABLE', 'UNAVAILABLE'].includes(String(values.redis))
  ) {
    return null;
  }
  return {
    status: payload.status as PlatformServiceState,
    liveness: 'ALIVE',
    dependencies: {
      mongodb: values.mongodb as PlatformDependencyState,
      redis: values.redis as PlatformDependencyState,
    },
  };
}

function readinessStatus(
  dependencies: ReadinessPayload['dependencies'],
): PlatformServiceState {
  const availableCount =
    Number(dependencies.mongodb === 'AVAILABLE') +
    Number(dependencies.redis === 'AVAILABLE');
  return availableCount === 2
    ? 'READY'
    : availableCount === 1
      ? 'DEGRADED'
      : 'UNAVAILABLE';
}

@Injectable()
export class HttpPlatformServiceOperationsRepository implements PlatformServiceOperationsRepository {
  constructor(private readonly config: ConfigService) {}

  async listServices(): Promise<{ data: PlatformServiceOperationsSummary[] }> {
    const data = await Promise.all(
      PLATFORM_SERVICE_IDS.map((id) => this.probeService(id)),
    );
    return { data };
  }

  findService(
    id: PlatformServiceId,
  ): Promise<PlatformServiceOperationsSummary> {
    return this.probeService(id);
  }

  private async probeService(
    id: PlatformServiceId,
  ): Promise<PlatformServiceOperationsSummary> {
    const definition = serviceDefinitions[id];
    const baseUrl = this.config.get<string>(definition.configKey);
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(
        `${(baseUrl ?? definition.defaultUrl).replace(/\/$/, '')}/internal/health/ready`,
        { signal: AbortSignal.timeout(probeTimeoutMs) },
      );
      const payload = parseReadinessPayload(await response.json());
      if (!payload) {
        return this.unavailable(id, checkedAt, 'Health response was invalid.');
      }
      const readiness = readinessStatus(payload.dependencies);
      return {
        id,
        name: definition.name,
        status: readiness,
        availability: 'AVAILABLE',
        liveness: 'ALIVE',
        readiness,
        dependencies: payload.dependencies,
        lastCheckedAt: checkedAt,
        diagnosticsSummary:
          readiness === 'READY'
            ? 'Service and configured dependencies are ready.'
            : readiness === 'DEGRADED'
              ? 'Service is live; one or more configured dependencies are unavailable.'
              : 'Service is live; configured dependencies are unavailable.',
      };
    } catch {
      return this.unavailable(id, checkedAt, 'Service readiness probe failed.');
    }
  }

  private unavailable(
    id: PlatformServiceId,
    checkedAt: string,
    diagnosticsSummary: string,
  ): PlatformServiceOperationsSummary {
    return {
      id,
      name: serviceDefinitions[id].name,
      status: 'UNAVAILABLE',
      availability: 'UNAVAILABLE',
      liveness: 'UNAVAILABLE',
      readiness: 'UNAVAILABLE',
      dependencies: { mongodb: 'UNAVAILABLE', redis: 'UNAVAILABLE' },
      lastCheckedAt: checkedAt,
      diagnosticsSummary,
    };
  }
}
