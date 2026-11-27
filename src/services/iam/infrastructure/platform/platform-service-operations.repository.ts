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

function isMonolithRuntime(config: ConfigService): boolean {
  const mode =
    config.get<string>('CONTINUUM_RUNTIME_MODE') ??
    process.env.CONTINUUM_RUNTIME_MODE;
  return mode === 'monolith';
}

function isLocalDefaultServiceUrl(
  configuredUrl: string | undefined,
  defaultUrl: string,
): boolean {
  if (!configuredUrl || configuredUrl.trim() === '') return true;
  const normalized = configuredUrl.trim().replace(/\/$/, '');
  return (
    normalized === defaultUrl ||
    normalized === defaultUrl.replace('127.0.0.1', 'localhost')
  );
}

@Injectable()
export class HttpPlatformServiceOperationsRepository implements PlatformServiceOperationsRepository {
  constructor(private readonly config: ConfigService) {}

  async listServices(): Promise<{ data: PlatformServiceOperationsSummary[] }> {
    const monolithBaseUrl = isMonolithRuntime(this.config)
      ? (
          this.config.get<string>('IAM_SERVICE_URL') ??
          serviceDefinitions.iam.defaultUrl
        ).replace(/\/$/, '')
      : null;
    let sharedMonolithProbe: Promise<ReadinessPayload | null> | null = null;
    const getSharedMonolithProbe = (): Promise<ReadinessPayload | null> => {
      if (!sharedMonolithProbe) {
        sharedMonolithProbe = this.fetchReadiness(
          monolithBaseUrl ?? serviceDefinitions.iam.defaultUrl,
          true,
        );
      }
      return sharedMonolithProbe;
    };

    const data = await Promise.all(
      PLATFORM_SERVICE_IDS.map((id) =>
        this.probeService(id, monolithBaseUrl ? getSharedMonolithProbe : null),
      ),
    );
    return { data };
  }

  findService(
    id: PlatformServiceId,
  ): Promise<PlatformServiceOperationsSummary> {
    return this.probeService(id);
  }

  private async fetchReadiness(
    baseUrl: string,
    preferMonolithPublicPath = false,
  ): Promise<ReadinessPayload | null> {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const primaryPath = preferMonolithPublicPath
      ? '/api/v1/health/ready'
      : '/internal/health/ready';
    const fallbackPath = preferMonolithPublicPath
      ? '/internal/health/ready'
      : '/api/v1/health/ready';

    let response = await fetch(`${cleanBase}${primaryPath}`, {
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    if (response.status === 404) {
      response = await fetch(`${cleanBase}${fallbackPath}`, {
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
    }
    return parseReadinessPayload(await response.json());
  }

  private async probeService(
    id: PlatformServiceId,
    getSharedMonolithProbe?: (() => Promise<ReadinessPayload | null>) | null,
  ): Promise<PlatformServiceOperationsSummary> {
    const definition = serviceDefinitions[id];
    const baseUrl = this.config.get<string>(definition.configKey);
    const checkedAt = new Date().toISOString();
    const useMonolithSelfProbe =
      isMonolithRuntime(this.config) &&
      isLocalDefaultServiceUrl(baseUrl, definition.defaultUrl);

    try {
      const payload = useMonolithSelfProbe
        ? await (getSharedMonolithProbe
            ? getSharedMonolithProbe()
            : this.fetchReadiness(
                this.config.get<string>('IAM_SERVICE_URL') ??
                  serviceDefinitions.iam.defaultUrl,
                true,
              ))
        : await this.fetchReadiness(baseUrl ?? definition.defaultUrl, false);

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
            ? useMonolithSelfProbe
              ? 'Monolith-hosted service and configured dependencies are ready.'
              : 'Service and configured dependencies are ready.'
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
