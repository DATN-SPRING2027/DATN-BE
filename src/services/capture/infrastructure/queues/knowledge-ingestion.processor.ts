import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  KnowledgeOutboxConsumer,
  type KnowledgeOutboxRunResult,
} from '../outbox/knowledge-outbox.consumer';
import type { QueueJobData } from './queue-runtime';
import { QUEUE_NAMES } from './queue.names';

const INGESTION_WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(64, Number(process.env.INGESTION_WORKER_CONCURRENCY ?? 8) || 8),
);

@Processor(QUEUE_NAMES.ingestion, {
  concurrency: INGESTION_WORKER_CONCURRENCY,
})
export class KnowledgeIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(KnowledgeIngestionProcessor.name);

  constructor(
    private readonly knowledgeOutboxConsumer: KnowledgeOutboxConsumer,
  ) {
    super();
  }

  async process(
    job: Job<QueueJobData>,
  ): Promise<{ documentId: string; outcomes: KnowledgeOutboxRunResult[] }> {
    const rawDocumentId = job.data?.payload?.documentId;
    const documentId =
      typeof rawDocumentId === 'string' ? rawDocumentId.trim() : '';
    if (!documentId) {
      return { documentId: '', outcomes: [] };
    }

    const outcomes =
      await this.knowledgeOutboxConsumer.processDocumentEvents(documentId);

    if (outcomes.includes('RETRY')) {
      this.logger.warn(
        `knowledge_ingestion_worker_retry_scheduled (${documentId}, job=${String(job.id ?? '')})`,
      );
      throw new Error(`KNOWLEDGE_INGESTION_RETRY_PENDING:${documentId}`);
    }

    return { documentId, outcomes };
  }
}
