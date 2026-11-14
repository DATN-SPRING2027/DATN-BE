import type { ConfigService } from '@nestjs/config';
import { SagPlatformAiOperationsRepository } from './platform-ai-operations.repository';

describe('SagPlatformAiOperationsRepository', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('reads SAG liveness and readiness separately and projects only safe operational state', async () => {
    const repository = new SagPlatformAiOperationsRepository({
      get: () => 'http://sag-api:8000',
    } as unknown as ConfigService);
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === 'string'
            ? input
            : input.url;
      return Promise.resolve(
        url.endsWith('/health')
          ? new Response(JSON.stringify({ status: 'ok' }))
          : new Response(
              JSON.stringify({
                status: 'unavailable',
                db: true,
                credential: 'must-not-escape',
              }),
              { status: 503 },
            ),
      );
    });

    const status = await repository.getStatus();

    expect(status).toMatchObject({
      id: 'sag',
      status: 'DEGRADED',
      availability: 'AVAILABLE',
      liveness: 'ALIVE',
      readiness: 'UNAVAILABLE',
      dependencies: {
        database: 'AVAILABLE',
        knowledgeRuntime: 'UNAVAILABLE',
        modelProvider: 'NOT_EXPOSED',
      },
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(status)).not.toContain('credential');
  });

  it('returns an unavailable summary without forwarding external error text', async () => {
    const repository = new SagPlatformAiOperationsRepository({
      get: () => undefined,
    } as unknown as ConfigService);
    global.fetch = jest.fn().mockRejectedValue(new Error('api_key=private'));

    const status = await repository.getStatus();

    expect(status).toMatchObject({
      status: 'UNAVAILABLE',
      availability: 'UNAVAILABLE',
      liveness: 'UNAVAILABLE',
      readiness: 'UNAVAILABLE',
    });
    expect(JSON.stringify(status)).not.toContain('private');
  });

  it('fetches authenticated SAG operational telemetry when SAG_BFF_SERVICE_TOKEN is configured', async () => {
    const validToken = 's'.repeat(40);
    const repository = new SagPlatformAiOperationsRepository({
      get: (key: string) => {
        if (key === 'SAG_API_BASE_URL') return 'http://sag-api:8000/';
        if (key === 'SAG_BFF_SERVICE_TOKEN') return validToken;
        return undefined;
      },
    } as unknown as ConfigService);

    const calls: Array<{ url: string; serviceToken: string | null }> = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === 'string'
            ? input
            : input.url;
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        serviceToken: headers.get('X-SAG-BFF-Service-Token'),
      });
      if (url.endsWith('/api/v1/system/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' })));
      }
      if (url.endsWith('/api/v1/system/ready')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ status: 'ready', db: true, qdrant: true }),
          ),
        );
      }
      if (url.endsWith('/api/v1/platform/ai/operations')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'ready',
              db_ready: true,
              knowledge_runtime_ready: true,
              qdrant_ready: true,
              runtime: {
                llm_configured: true,
                llm_provider: 'openai',
                llm_model: 'Qwen/Qwen3-8B',
                retrieval_model: 'Qwen/Qwen3-Embedding-0.6B',
                vector_store: 'qdrant',
                parser_provider: 'mineru',
                worker_concurrency: 4,
              },
              jobs: {
                queued: 0,
                running: 0,
                paused: 0,
                succeeded: 352,
                failed: 34,
              },
              corpus: {
                ready: 221,
                processing: 0,
                paused: 0,
                failed: 0,
              },
              secret_should_be_ignored: 'sk-do-not-pass',
            }),
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const status = await repository.getStatus();

    expect(calls).toEqual([
      { url: 'http://sag-api:8000/api/v1/system/health', serviceToken: null },
      { url: 'http://sag-api:8000/api/v1/system/ready', serviceToken: null },
      {
        url: 'http://sag-api:8000/api/v1/platform/ai/operations',
        serviceToken: validToken,
      },
    ]);
    expect(status).toMatchObject({
      id: 'sag',
      name: 'SAG',
      status: 'READY',
      availability: 'AVAILABLE',
      liveness: 'ALIVE',
      readiness: 'READY',
      dependencies: {
        database: 'AVAILABLE',
        knowledgeRuntime: 'READY',
        retrieval: 'READY',
        modelProvider: 'CONFIGURED',
        processingJobs: 'IDLE',
        failedProcessingSummary: 'HAS_FAILURES',
      },
      runtimeProfile: {
        llmConfigured: true,
        llmProvider: 'openai',
        llmModel: 'Qwen/Qwen3-8B',
        retrievalModel: 'Qwen/Qwen3-Embedding-0.6B',
        vectorStore: 'qdrant',
        parserProvider: 'mineru',
        workerConcurrency: 4,
      },
      jobSummary: {
        queued: 0,
        running: 0,
        paused: 0,
        succeeded: 352,
        failed: 34,
      },
      corpusSummary: {
        ready: 221,
        processing: 0,
        paused: 0,
        failed: 0,
      },
    });
    expect(JSON.stringify(status)).not.toContain('sk-do-not-pass');
  });

  it('distinguishes knowledgeRuntime vs Qdrant retrieval when retrieval is unavailable', async () => {
    const validToken = 't'.repeat(40);
    const repository = new SagPlatformAiOperationsRepository({
      get: (key: string) => {
        if (key === 'SAG_SERVICE_URL') return 'http://sag-api:8000';
        if (key === 'SAG_BFF_SERVICE_TOKEN') return validToken;
        return undefined;
      },
    } as unknown as ConfigService);

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === 'string'
            ? input
            : input.url;
      if (url.endsWith('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' })));
      }
      if (url.endsWith('/ready')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'unavailable',
              db: true,
              knowledge_runtime: true,
              qdrant: false,
            }),
            { status: 503 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'degraded',
            db_ready: true,
            knowledge_runtime_ready: true,
            qdrant_ready: false,
            runtime: {
              llm_configured: false,
              llm_provider: null,
              llm_model: null,
              retrieval_model: null,
              vector_store: 'qdrant',
              parser_provider: 'markitdown',
              worker_concurrency: 2,
            },
            jobs: {
              queued: 1,
              running: 2,
              paused: 0,
              succeeded: 10,
              failed: 0,
            },
            corpus: { ready: 5, processing: 1, paused: 0, failed: 0 },
          }),
        ),
      );
    });

    const status = await repository.getStatus();

    expect(status).toMatchObject({
      status: 'DEGRADED',
      readiness: 'UNAVAILABLE',
      dependencies: {
        database: 'AVAILABLE',
        knowledgeRuntime: 'READY',
        retrieval: 'UNAVAILABLE',
        modelProvider: 'UNCONFIGURED',
        processingJobs: 'ACTIVE',
        failedProcessingSummary: 'NONE',
      },
    });
  });

  it('falls back safely to UNKNOWN and strips unsafe identifiers when operations probe fails or returns unsafe fields', async () => {
    const validToken = 'u'.repeat(40);
    const repository = new SagPlatformAiOperationsRepository({
      get: (key: string) => {
        if (key === 'SAG_API_BASE_URL') return 'http://sag-api:8000';
        if (key === 'SAG_BFF_SERVICE_TOKEN') return validToken;
        return undefined;
      },
    } as unknown as ConfigService);

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === 'string'
            ? input
            : input.url;
      if (url.endsWith('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' })));
      }
      if (url.endsWith('/ready')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ status: 'ready', db: true, qdrant: true }),
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), {
          status: 403,
        }),
      );
    });

    const failedOps = await repository.getStatus();
    expect(failedOps).toMatchObject({
      status: 'READY',
      readiness: 'READY',
      dependencies: {
        database: 'AVAILABLE',
        knowledgeRuntime: 'READY',
        retrieval: 'READY',
        modelProvider: 'UNKNOWN',
        processingJobs: 'UNKNOWN',
        failedProcessingSummary: 'UNKNOWN',
      },
      runtimeProfile: null,
      jobSummary: null,
      corpusSummary: null,
    });

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === 'string'
            ? input
            : input.url;
      if (url.endsWith('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' })));
      }
      if (url.endsWith('/ready')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ status: 'ready', db: true, qdrant: true }),
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'ready',
            db_ready: true,
            knowledge_runtime_ready: true,
            qdrant_ready: true,
            runtime: {
              llm_configured: true,
              llm_provider: 'https://user:pass@internal/v1',
              llm_model: 'api_key=sk-secret',
              retrieval_model: 'Qwen/Qwen3-Embedding-0.6B',
              vector_store: 'qdrant',
              parser_provider: 'mineru',
              worker_concurrency: 4,
            },
            jobs: { queued: 0, running: 0, paused: 0, succeeded: 1, failed: 0 },
            corpus: { ready: 1, processing: 0, paused: 0, failed: 0 },
          }),
        ),
      );
    });

    const sanitized = await repository.getStatus();
    expect(sanitized.runtimeProfile).toEqual({
      llmConfigured: true,
      llmProvider: null,
      llmModel: null,
      retrievalModel: 'Qwen/Qwen3-Embedding-0.6B',
      vectorStore: 'qdrant',
      parserProvider: 'mineru',
      workerConcurrency: 4,
    });
  });
});
