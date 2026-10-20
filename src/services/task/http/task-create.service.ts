import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { isObjectIdString } from '../infrastructure/mongodb/task-contract';
import type { TaskDataRepository } from '../infrastructure/mongodb/task-data.repository';
import {
  taskInternalErrorException,
  taskValidationFailedException,
} from '../runtime/task-authorization-http.errors';
import { toTaskResponse, type TaskResponse } from './task-response';

export const TASK_CREATE_REPOSITORY = Symbol('TASK_CREATE_REPOSITORY');

/** Write view of the existing repository; no schema or index change. */
export type TaskCreateRepository = Pick<TaskDataRepository, 'create'>;

/** The verified actor and Project bound by the authorization boundary. */
export interface TaskCreateActor {
  projectId: string;
  actorUserId: string;
  requestId: string;
}

/**
 * Maps the repository result of the create operation to the HTTP outcome of the
 * DATN-97 create contract (CREATE-2, DR7D-1). The repository validates the
 * body, so a rejected body is reported as 422 after authorization.
 */
@Injectable()
export class TaskCreateService {
  private readonly logger = new Logger(TaskCreateService.name);

  constructor(
    @Inject(TASK_CREATE_REPOSITORY)
    private readonly repository: TaskCreateRepository,
  ) {}

  async create(actor: TaskCreateActor, body: unknown): Promise<TaskResponse> {
    if (
      !isObjectIdString(actor.projectId) ||
      !isObjectIdString(actor.actorUserId)
    ) {
      this.logger.error('Task create received an invalid trusted context');
      throw taskInternalErrorException();
    }

    const result = await this.repository.create(
      {
        projectId: new Types.ObjectId(actor.projectId),
        actorId: new Types.ObjectId(actor.actorUserId),
        requestId: actor.requestId,
      },
      body,
    );

    switch (result.state) {
      case 'COMMITTED':
        return toTaskResponse(result.task);
      case 'REJECTED':
        if (result.reason === 'INVALID_INPUT') {
          throw taskValidationFailedException([
            'the body must be a JSON object with only a title that contains a non-white-space character',
          ]);
        }
        // INVALID_TRUSTED_CONTEXT: the context was built from verified claims.
        this.logger.error(`Task create was rejected (${result.reason})`);
        throw taskInternalErrorException();
      case 'ABORTED':
        throw new ServiceUnavailableException({
          code: 'RETRY_LATER',
          message: 'The operation was not applied, retry later',
        });
      case 'UNCERTAIN':
        throw new ServiceUnavailableException({
          code: 'TASK_CREATE_UNCERTAIN',
          message: 'The outcome of the create operation is unknown',
          details: { taskId: result.taskId },
        });
    }
  }
}
