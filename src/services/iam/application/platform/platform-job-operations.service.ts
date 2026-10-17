import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PLATFORM_JOB_OPERATIONS_REPOSITORY,
  PLATFORM_JOB_FILTER_STATES,
  PLATFORM_QUEUE_IDS,
  type PlatformJobCommandInput,
  type PlatformJobCommandResult,
  type PlatformJobListInput,
  type PlatformJobOperationsRepository,
  type PlatformQueueId,
} from './platform-job-operations.repository';

const queueIds: readonly string[] = PLATFORM_QUEUE_IDS;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

@Injectable()
export class PlatformJobOperationsService {
  constructor(
    @Inject(PLATFORM_JOB_OPERATIONS_REPOSITORY)
    private readonly repository: PlatformJobOperationsRepository,
  ) {}

  listQueues() {
    return this.repository.listQueues();
  }

  async findQueue(id: string) {
    if (!queueIds.includes(id)) {
      throw new NotFoundException({ code: 'PLATFORM_QUEUE_NOT_FOUND' });
    }
    const queue = await this.repository.findQueue(id as PlatformQueueId);
    if (!queue)
      throw new NotFoundException({ code: 'PLATFORM_QUEUE_NOT_FOUND' });
    return queue;
  }

  listJobs(input: PlatformJobListInput) {
    if (
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > 100 ||
      (input.queueId !== undefined && !queueIds.includes(input.queueId)) ||
      (input.status !== undefined &&
        !(PLATFORM_JOB_FILTER_STATES as readonly string[]).includes(
          input.status,
        ))
    ) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    }
    return this.repository.listJobs(input);
  }

  async findJob(queueId: string, jobId: string) {
    if (
      !queueIds.includes(queueId) ||
      typeof jobId !== 'string' ||
      jobId.length < 1 ||
      jobId.length > 200 ||
      containsControlCharacter(jobId)
    ) {
      throw new NotFoundException({ code: 'PLATFORM_JOB_NOT_FOUND' });
    }
    const job = await this.repository.findJob(
      queueId as PlatformQueueId,
      jobId,
    );
    if (!job) throw new NotFoundException({ code: 'PLATFORM_JOB_NOT_FOUND' });
    return job;
  }

  async execute(
    input: PlatformJobCommandInput,
  ): Promise<{ body: PlatformJobCommandResult; replayed: boolean }> {
    if (
      !input ||
      !/^[a-f\d]{24}$/i.test(input.actorUserId) ||
      !queueIds.includes(input.queueId) ||
      typeof input.jobId !== 'string' ||
      input.jobId.length < 1 ||
      input.jobId.length > 200 ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(input.jobId) ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey) ||
      (input.correlationId !== undefined &&
        !/^[A-Za-z0-9._:-]{1,128}$/.test(input.correlationId)) ||
      !input.command ||
      (input.command.command === 'RETRY'
        ? input.command.expectedStatus !== 'FAILED'
        : input.command.command === 'CANCEL'
          ? !['WAITING', 'DELAYED'].includes(input.command.expectedStatus)
          : true)
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    return this.repository.execute(input);
  }
}
