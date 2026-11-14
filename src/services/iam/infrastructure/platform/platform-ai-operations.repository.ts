import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PlatformAiCorpusSummary,
  PlatformAiJobSummary,
  PlatformAiOperationsRepository,
  PlatformAiOperationsSummary,
  PlatformAiRuntimeProfile,
  PlatformAiRuntimeState,
} from '../../application/platform/platform-ai-operations.repository';

const probeTimeoutMs = 2_000;
const safeIdentifierPattern = /^[A-Za-z0-9._:/+-]{1,128}$/;
const forbiddenIdentifierPattern =
  /(api_?key|secret|token|password|credential|bearer|:\/\/|@|=)/i;

interface SagReadiness {
  status: 'ready' | 'unavailable';
  db: boolean;
  knowledgeRuntime?: boolean;
  qdrant?: boolean | null;
}

interface SagOperationsPayload {
  status: 'ready' | 'degraded';
  dbReady: boolean;
  knowledgeRuntimeReady: boolean;
  qdrantReady: boolean | null;
  runtimeProfile: PlatformAiRuntimeProfile;
  jobSummary: PlatformAiJobSummary;
  corpusSummary: PlatformAiCorpusSummary;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sanitizeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    !safeIdentifierPattern.test(trimmed) ||
    forbiddenIdentifierPattern.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function parseSagReadiness(value: unknown): SagReadiness | null {
  const readiness = asRecord(value);
  if (
    !readiness ||
    !['ready', 'unavailable'].includes(String(readiness.status)) ||
    typeof readiness.db !== 'boolean'
  ) {
    return null;
  }
  return {
    status: readiness.status as SagReadiness['status'],
    db: readiness.db,
    ...(typeof readiness.knowledge_runtime === 'boolean'
      ? { knowledgeRuntime: readiness.knowledge_runtime }
      : {}),
    ...(typeof readiness.qdrant === 'boolean' || readiness.qdrant === null
      ? { qdrant: readiness.qdrant }
      : {}),
  };
}

function parseSagOperations(value: unknown): SagOperationsPayload | null {
  const root = asRecord(value);
  if (
    !root ||
    !['ready', 'degraded'].includes(String(root.status)) ||
    typeof root.db_ready !== 'boolean' ||
    typeof root.knowledge_runtime_ready !== 'boolean' ||
    (typeof root.qdrant_ready !== 'boolean' && root.qdrant_ready !== null)
  ) {
    return null;
  }

  const runtime = asRecord(root.runtime);
  const jobs = asRecord(root.jobs);
  const corpus = asRecord(root.corpus);
  if (!runtime || !jobs || !corpus) {
    return null;
  }

  if (typeof runtime.llm_configured !== 'boolean') {
    return null;
  }
  const workerConcurrency = nonNegativeInt(runtime.worker_concurrency);
  const queued = nonNegativeInt(jobs.queued);
  const running = nonNegativeInt(jobs.running);
  const pausedJobs = nonNegativeInt(jobs.paused);
  const succeeded = nonNegativeInt(jobs.succeeded);
  const failedJobs = nonNegativeInt(jobs.failed);
  const readyCorpus = nonNegativeInt(corpus.ready);
  const processingCorpus = nonNegativeInt(corpus.processing);
  const pausedCorpus = nonNegativeInt(corpus.paused);
  const failedCorpus = nonNegativeInt(corpus.failed);
  if (
    workerConcurrency === null ||
    workerConcurrency < 1 ||
    queued === null ||
    running === null ||
    pausedJobs === null ||
    succeeded === null ||
    failedJobs === null ||
    readyCorpus === null ||
    processingCorpus === null ||
    pausedCorpus === null ||
    failedCorpus === null
  ) {
    return null;
  }

  return {
    status: root.status as SagOperationsPayload['status'],
    dbReady: root.db_ready,
    knowledgeRuntimeReady: root.knowledge_runtime_ready,
    qdrantReady: root.qdrant_ready,
    runtimeProfile: {
      llmConfigured: runtime.llm_configured,
      llmProvider: sanitizeIdentifier(runtime.llm_provider),
      llmModel: sanitizeIdentifier(runtime.llm_model),
      retrievalModel: sanitizeIdentifier(runtime.retrieval_model),
      vectorStore: sanitizeIdentifier(runtime.vector_store),
      parserProvider: sanitizeIdentifier(runtime.parser_provider),
      workerConcurrency,
    },
    jobSummary: {
      queued,
      running,
      paused: pausedJobs,
      succeeded,
      failed: failedJobs,
    },
    corpusSummary: {
      ready: readyCorpus,
      processing: processingCorpus,
      paused: pausedCorpus,
      failed: failedCorpus,
    },
  };
}

@Injectable()
export class SagPlatformAiOperationsRepository implements PlatformAiOperationsRepository {
  constructor(private readonly config: ConfigService) {}

  async getStatus(): Promise<PlatformAiOperationsSummary> {
    const baseUrl =
      this.config.get<string>('SAG_API_BASE_URL')?.trim() ||
      this.config.get<string>('SAG_SERVICE_URL')?.trim() ||
      'http://127.0.0.1:8000';
    const rawServiceToken = this.config.get<string>('SAG_BFF_SERVICE_TOKEN');
    const serviceToken =
      typeof rawServiceToken === 'string' && rawServiceToken.trim().length >= 32
        ? rawServiceToken.trim()
        : null;
    const checkedAt = new Date().toISOString();
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

    const probes: Array<Promise<{ ok: boolean; payload: unknown } | null>> = [
      this.probe(`${normalizedBaseUrl}/api/v1/system/health`),
      this.probe(`${normalizedBaseUrl}/api/v1/system/ready`),
    ];
    if (serviceToken) {
      probes.push(
        this.probe(`${normalizedBaseUrl}/api/v1/platform/ai/operations`, {
          'X-SAG-BFF-Service-Token': serviceToken,
        }),
      );
    }

    const [livenessResult, readinessResult, opsResult] =
      await Promise.all(probes);
    if (!livenessResult || !livenessResult.ok) {
      return this.unavailable(checkedAt, serviceToken !== null);
    }

    const readiness = readinessResult
      ? parseSagReadiness(readinessResult.payload)
      : null;
    const ops =
      serviceToken && opsResult?.ok
        ? parseSagOperations(opsResult.payload)
        : null;
    const fallbackOpsState = serviceToken ? 'UNKNOWN' : 'NOT_EXPOSED';

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
          modelProvider: ops
            ? ops.runtimeProfile.llmConfigured
              ? 'CONFIGURED'
              : 'UNCONFIGURED'
            : fallbackOpsState,
          processingJobs: ops
            ? ops.jobSummary.queued +
                ops.jobSummary.running +
                ops.corpusSummary.processing >
              0
              ? 'ACTIVE'
              : 'IDLE'
            : fallbackOpsState,
          failedProcessingSummary: ops
            ? ops.jobSummary.failed + ops.corpusSummary.failed > 0
              ? 'HAS_FAILURES'
              : 'NONE'
            : fallbackOpsState,
        },
        runtimeProfile: ops?.runtimeProfile ?? null,
        jobSummary: ops?.jobSummary ?? null,
        corpusSummary: ops?.corpusSummary ?? null,
        lastCheckedAt: checkedAt,
        diagnosticsSummary:
          'SAG is live, but its safe readiness projection is unavailable.',
      };
    }

    const ready =
      readinessResult?.ok === true &&
      readiness.status === 'ready' &&
      readiness.db;
    const knowledgeRuntimeState: PlatformAiRuntimeState = ops
      ? ops.knowledgeRuntimeReady
        ? 'READY'
        : 'UNAVAILABLE'
      : typeof readiness.knowledgeRuntime === 'boolean'
        ? readiness.knowledgeRuntime
          ? 'READY'
          : 'UNAVAILABLE'
        : ready
          ? 'READY'
          : 'UNAVAILABLE';
    const retrievalState: PlatformAiRuntimeState = ops
      ? ops.qdrantReady === false
        ? 'UNAVAILABLE'
        : ops.qdrantReady === true
          ? 'READY'
          : knowledgeRuntimeState
      : typeof readiness.qdrant === 'boolean'
        ? readiness.qdrant
          ? 'READY'
          : 'UNAVAILABLE'
        : ready
          ? 'READY'
          : 'UNAVAILABLE';

    const effectiveReady =
      ready && knowledgeRuntimeState === 'READY' && retrievalState === 'READY';

    return {
      id: 'sag',
      name: 'SAG',
      status: effectiveReady ? 'READY' : 'DEGRADED',
      availability: 'AVAILABLE',
      liveness: 'ALIVE',
      readiness: effectiveReady ? 'READY' : 'UNAVAILABLE',
      dependencies: {
        database: readiness.db ? 'AVAILABLE' : 'UNAVAILABLE',
        knowledgeRuntime: knowledgeRuntimeState,
        retrieval: retrievalState,
        modelProvider: ops
          ? ops.runtimeProfile.llmConfigured
            ? 'CONFIGURED'
            : 'UNCONFIGURED'
          : fallbackOpsState,
        processingJobs: ops
          ? ops.jobSummary.queued +
              ops.jobSummary.running +
              ops.corpusSummary.processing >
            0
            ? 'ACTIVE'
            : 'IDLE'
          : fallbackOpsState,
        failedProcessingSummary: ops
          ? ops.jobSummary.failed + ops.corpusSummary.failed > 0
            ? 'HAS_FAILURES'
            : 'NONE'
          : fallbackOpsState,
      },
      runtimeProfile: ops?.runtimeProfile ?? null,
      jobSummary: ops?.jobSummary ?? null,
      corpusSummary: ops?.corpusSummary ?? null,
      lastCheckedAt: checkedAt,
      diagnosticsSummary: effectiveReady
        ? serviceToken && !ops
          ? 'SAG readiness is healthy, but runtime and job telemetry is temporarily unavailable.'
          : 'SAG metadata database and knowledge runtime report ready.'
        : 'SAG is live, but the metadata database, vector store, or runtime is not ready.',
    };
  }

  private async probe(
    url: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ ok: boolean; payload: unknown } | null> {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', ...extraHeaders },
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

  private unavailable(
    checkedAt: string,
    serviceTokenConfigured: boolean,
  ): PlatformAiOperationsSummary {
    const opsFallback = serviceTokenConfigured ? 'UNKNOWN' : 'NOT_EXPOSED';
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
        modelProvider: opsFallback,
        processingJobs: opsFallback,
        failedProcessingSummary: opsFallback,
      },
      runtimeProfile: null,
      jobSummary: null,
      corpusSummary: null,
      lastCheckedAt: checkedAt,
      diagnosticsSummary: 'SAG service cannot be reached.',
    };
  }
}
