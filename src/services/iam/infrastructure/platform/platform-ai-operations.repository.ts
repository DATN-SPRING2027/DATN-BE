import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PlatformAiOperationsRepository,
  PlatformAiOperationsSummary,
} from '../../application/platform/platform-ai-operations.repository';

const probeTimeoutMs = 2_000;

interface SagReadiness {
  status: 'ready' | 'unavailable';
  db: boolean;
}

function parseSagReadiness(value: unknown): SagReadiness | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const readiness = value as Record<string, unknown>;
  if (
    !['ready', 'unavailable'].includes(String(readiness.status)) ||
    typeof readiness.db !== 'boolean'
  ) {
    return null;
  }
  return {
    status: readiness.status as SagReadiness['status'],
    db: readiness.db,
  };
}

@Injectable()
export class SagPlatformAiOperationsRepository implements PlatformAiOperationsRepository {
  constructor(private readonly config: ConfigService) {}

  async getStatus(): Promise<PlatformAiOperationsSummary> {
    const baseUrl =
      this.config.get<string>('SAG_SERVICE_URL') ?? 'http://127.0.0.1:8000';
    const checkedAt = new Date().toISOString();
    const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
    const [livenessResult, readinessResult] = await Promise.all([
      this.probe(`${normalizedBaseUrl}/api/v1/system/health`),
      this.probe(`${normalizedBaseUrl}/api/v1/system/ready`),
    ]);
    if (!livenessResult || !livenessResult.ok) {
      return this.unavailable(checkedAt);
    }

    const readiness = readinessResult
      ? parseSagReadiness(readinessResult.payload)
      : null;
    if (!readiness) {
      return {
        id: 'sag',
        name: 'SAG',
        status: 'DEGRADED',
        availability: 'AVAILABLE',
        liveness: 'ALIVE',
        readiness: 'UNAVAILABLE',
        dependencies: {
          database: 'UNKNOWN',
          knowledgeRuntime: 'UNKNOWN',
          retrieval: 'UNKNOWN',
          modelProvider: 'NOT_EXPOSED',
          processingJobs: 'NOT_EXPOSED',
          failedProcessingSummary: 'NOT_EXPOSED',
        },
        lastCheckedAt: checkedAt,
        diagnosticsSummary:
          'SAG is live, but its safe readiness projection is unavailable.',
      };
    }

    const ready =
      readinessResult?.ok === true &&
      readiness.status === 'ready' &&
      readiness.db;
    const runtimeState = ready ? 'READY' : 'UNAVAILABLE';
    return {
      id: 'sag',
      name: 'SAG',
      status: ready ? 'READY' : 'DEGRADED',
      availability: 'AVAILABLE',
      liveness: 'ALIVE',
      readiness: ready ? 'READY' : 'UNAVAILABLE',
      dependencies: {
        database: readiness.db ? 'AVAILABLE' : 'UNAVAILABLE',
        knowledgeRuntime: runtimeState,
        retrieval: runtimeState,
        modelProvider: 'NOT_EXPOSED',
        processingJobs: 'NOT_EXPOSED',
        failedProcessingSummary: 'NOT_EXPOSED',
      },
      lastCheckedAt: checkedAt,
      diagnosticsSummary: ready
        ? 'SAG metadata database and knowledge runtime report ready.'
        : 'SAG is live, but the metadata database or knowledge runtime is not ready.',
    };
  }

  private async probe(
    url: string,
  ): Promise<{ ok: boolean; payload: unknown } | null> {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      return { ok: response.ok, payload };
    } catch {
      return null;
    }
  }

  private unavailable(checkedAt: string): PlatformAiOperationsSummary {
    return {
      id: 'sag',
      name: 'SAG',
      status: 'UNAVAILABLE',
      availability: 'UNAVAILABLE',
      liveness: 'UNAVAILABLE',
      readiness: 'UNAVAILABLE',
      dependencies: {
        database: 'UNKNOWN',
        knowledgeRuntime: 'UNKNOWN',
        retrieval: 'UNKNOWN',
        modelProvider: 'NOT_EXPOSED',
        processingJobs: 'NOT_EXPOSED',
        failedProcessingSummary: 'NOT_EXPOSED',
      },
      lastCheckedAt: checkedAt,
      diagnosticsSummary: 'SAG service cannot be reached.',
    };
  }
}
