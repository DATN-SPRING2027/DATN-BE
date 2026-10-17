import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PLATFORM_SERVICE_IDS } from './platform-service-operations.repository';
import { redactIncidentNote } from './platform-incident-note.redaction';
import {
  PLATFORM_INCIDENT_REPOSITORY,
  PLATFORM_INCIDENT_SEVERITIES,
  PLATFORM_INCIDENT_STATUSES,
  type PlatformIncidentCommandInput,
  type PlatformIncidentListInput,
  type PlatformIncidentPage,
  type PlatformIncidentRepository,
  type PlatformIncidentSummary,
  type PlatformIncidentHistoryItem,
} from './platform-incident.repository';

const objectIdPattern = /^[a-f\d]{24}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const correlationPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function invalid(): never {
  throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

@Injectable()
export class PlatformIncidentService {
  constructor(
    @Inject(PLATFORM_INCIDENT_REPOSITORY)
    private readonly repository: PlatformIncidentRepository,
  ) {}

  async list(
    input: PlatformIncidentListInput,
  ): Promise<PlatformIncidentPage<PlatformIncidentSummary>> {
    this.validatePage(input.page, input.pageSize);
    if (
      (input.status !== undefined &&
        !PLATFORM_INCIDENT_STATUSES.includes(input.status)) ||
      (input.severity !== undefined &&
        !PLATFORM_INCIDENT_SEVERITIES.includes(input.severity)) ||
      (input.affectedServiceId !== undefined &&
        !(PLATFORM_SERVICE_IDS as readonly string[]).includes(
          input.affectedServiceId,
        ))
    )
      invalid();
    return this.repository.list(input);
  }

  async find(incidentId: string): Promise<PlatformIncidentSummary> {
    if (!objectIdPattern.test(incidentId)) invalid();
    const incident = await this.repository.find(incidentId);
    if (!incident)
      throw new NotFoundException({ code: 'PLATFORM_INCIDENT_NOT_FOUND' });
    return incident;
  }

  async listHistory(input: {
    incidentId: string;
    page: number;
    pageSize: number;
  }): Promise<PlatformIncidentPage<PlatformIncidentHistoryItem>> {
    if (!objectIdPattern.test(input.incidentId)) invalid();
    this.validatePage(input.page, input.pageSize);
    await this.find(input.incidentId);
    const page = await this.repository.listHistory(input);
    return {
      ...page,
      data: page.data.map((item) => ({
        ...item,
        ...(item.note ? { note: redactIncidentNote(item.note) } : {}),
      })),
    };
  }

  async execute(input: Omit<PlatformIncidentCommandInput, 'now'>): Promise<{
    httpStatus: 200 | 201;
    replayed: boolean;
    body: PlatformIncidentSummary;
  }> {
    if (
      !objectIdPattern.test(input.actorUserId) ||
      !idempotencyPattern.test(input.idempotencyKey) ||
      (input.correlationId !== undefined &&
        !correlationPattern.test(input.correlationId))
    )
      invalid();

    const command = input.command;
    if (command.command === 'CREATE') {
      if (
        Object.keys(command).length !== 4 ||
        typeof command.title !== 'string' ||
        command.title.trim().length < 1 ||
        command.title.trim().length > 160 ||
        containsControlCharacter(command.title) ||
        !PLATFORM_INCIDENT_SEVERITIES.includes(command.severity) ||
        !(PLATFORM_SERVICE_IDS as readonly string[]).includes(
          command.affectedServiceId,
        )
      )
        invalid();
      const safeTitle = redactIncidentNote(command.title.trim());
      if (safeTitle.length < 1 || safeTitle.length > 160) invalid();
      return this.repository.execute({
        ...input,
        command: { ...command, title: safeTitle },
        now: new Date(),
      });
    }

    if (
      !['ACKNOWLEDGE', 'RESOLVE', 'ADD_NOTE'].includes(command.command) ||
      Object.keys(command).length !== 4 ||
      !objectIdPattern.test(command.incidentId) ||
      !Number.isSafeInteger(command.expectedVersion) ||
      command.expectedVersion < 1 ||
      typeof command.note !== 'string' ||
      command.note.trim().length < 1 ||
      command.note.trim().length > 2000
    )
      invalid();
    const safeNote = redactIncidentNote(command.note);
    return this.repository.execute({
      ...input,
      command: { ...command, note: safeNote },
      now: new Date(),
    });
  }

  private validatePage(page: number, pageSize: number): void {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      invalid();
  }
}
