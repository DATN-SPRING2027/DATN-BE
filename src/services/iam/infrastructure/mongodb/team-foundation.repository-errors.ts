import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

export function projectNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'PROJECT_NOT_FOUND',
    message: 'Project not found.',
  });
}

export function teamNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'TEAM_NOT_FOUND',
    message: 'Team not found.',
  });
}

export function actionForbidden(): ForbiddenException {
  return new ForbiddenException({
    code: 'TEAM_ACTION_FORBIDDEN',
    message: 'The requested Team action is not allowed.',
  });
}

export function policyNotReady(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'TEAM_POLICY_NOT_READY',
    message: 'Team persistence or authorization is not ready.',
  });
}

export function retryLater(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'RETRY_LATER',
    message: 'Retry the command with the same Idempotency-Key.',
  });
}

export function teamCodeConflict(): ConflictException {
  return new ConflictException({
    code: 'TEAM_CODE_EXISTS',
    message: 'A Team with this code already exists in the Project.',
  });
}

export class IdempotencySlotRace extends Error {}
