import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID, createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import { redactIncidentNote } from '../../application/platform/platform-incident-note.redaction';
import {
  PLATFORM_INCIDENT_REPOSITORY,
  type PlatformIncidentCommandInput,
  type PlatformIncidentHistoryItem,
  type PlatformIncidentListInput,
  type PlatformIncidentMutationResult,
  type PlatformIncidentPage,
  type PlatformIncidentRepository,
  type PlatformIncidentStatus,
  type PlatformIncidentSummary,
} from '../../application/platform/platform-incident.repository';
import { PLATFORM_SERVICE_IDS } from '../../application/platform/platform-service-operations.repository';
import { IAM_PERSISTENCE } from '../persistence';

const incidentPermission = 'platform.incidents.incident.manage';
const commonPlatformAuthorityFence = 'PLATFORM_OPERATOR_LIFECYCLE';

interface IncidentDocument {
  _id: Types.ObjectId;
  title: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: PlatformIncidentStatus;
  affectedServiceId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  acknowledgedAt?: Date;
  acknowledgedBy?: Types.ObjectId;
  resolvedAt?: Date;
  resolvedBy?: Types.ObjectId;
}

interface IncidentHistoryDocument {
  _id: Types.ObjectId;
  incidentId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  action: PlatformIncidentHistoryItem['action'];
  fromStatus?: PlatformIncidentStatus;
  toStatus: PlatformIncidentStatus;
  version: number;
  note?: string;
  occurredAt: Date;
}

interface IncidentOperationDocument {
  _id: Types.ObjectId;
  actorUserId: Types.ObjectId;
  idempotencyKeyHash: string;
  fingerprintHash: string;
  operationType: 'CREATE' | 'ACKNOWLEDGE' | 'RESOLVE' | 'ADD_NOTE';
  incidentId: Types.ObjectId;
  auditEventId: string;
  httpStatus: 200 | 201;
  resultBody: unknown;
  committedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonical(nested)]),
        )
      : value;
const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;

@Injectable()
export class MongoPlatformIncidentRepository implements PlatformIncidentRepository {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @Inject(AUDIT_DATABASE_NAME_TOKEN)
    private readonly auditDatabaseName = AUDIT_DATABASE_NAME,
  ) {}

  async list(
    input: PlatformIncidentListInput,
  ): Promise<PlatformIncidentPage<PlatformIncidentSummary>> {
    const filter: Record<string, unknown> = {};
    if (input.status) filter.status = input.status;
    if (input.severity) filter.severity = input.severity;
    if (input.affectedServiceId)
      filter.affectedServiceId = input.affectedServiceId;
    const [rows, totalItems] = await Promise.all([
      this.incidents()
        .find(filter)
        .project<IncidentDocument>(this.safeIncidentProjection())
        .sort({ updatedAt: -1, _id: -1 })
        .skip((input.page - 1) * input.pageSize)
        .limit(input.pageSize)
        .toArray(),
      this.incidents().countDocuments(filter),
    ]);
    return this.page(
      rows.map((row) => this.mapSummary(row)),
      input.page,
      input.pageSize,
      totalItems,
    );
  }

  async find(incidentId: string): Promise<PlatformIncidentSummary | null> {
    const row = await this.incidents().findOne(
      { _id: new Types.ObjectId(incidentId) },
      { projection: this.safeIncidentProjection() },
    );
    return row ? this.mapSummary(row) : null;
  }

  async listHistory(input: {
    incidentId: string;
    page: number;
    pageSize: number;
  }): Promise<PlatformIncidentPage<PlatformIncidentHistoryItem>> {
    const incidentId = new Types.ObjectId(input.incidentId);
    const [rows, totalItems] = await Promise.all([
      this.history()
        .find({ incidentId })
        .sort({ occurredAt: 1, _id: 1 })
        .skip((input.page - 1) * input.pageSize)
        .limit(input.pageSize)
        .toArray(),
      this.history().countDocuments({ incidentId }),
    ]);
    return this.page(
      rows.map((row) => this.mapHistory(row)),
      input.page,
      input.pageSize,
      totalItems,
    );
  }

  async execute(
    input: PlatformIncidentCommandInput,
  ): Promise<PlatformIncidentMutationResult> {
    const connection = this.connectionOrThrow();
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const idempotencyKeyHash = this.sha256(input.idempotencyKey);
    const fingerprintHash = this.sha256(
      JSON.stringify(canonical(input.command)),
    );
    const session = await connection.startSession();
    let result: PlatformIncidentMutationResult | undefined;
    try {
      await session.withTransaction(async () => {
        await this.acquireAuthorityFence(session);
        if (!(await this.hasPermission(actorUserId, input.now, session)))
          throw new ForbiddenException({ code: 'FORBIDDEN' });

        const prior = await this.operations().findOne(
          { actorUserId, idempotencyKeyHash },
          { session },
        );
        if (prior) {
          result = this.replay(prior, fingerprintHash);
          return;
        }

        const committed = await this.applyCommand(input, actorUserId, session);
        const auditEventId = randomUUID();
        const historyId = new Types.ObjectId();
        await this.history().insertOne(
          {
            _id: historyId,
            incidentId: committed.incidentId,
            actorUserId,
            action: committed.history.action,
            ...(committed.history.fromStatus
              ? { fromStatus: committed.history.fromStatus }
              : {}),
            toStatus: committed.history.toStatus,
            version: committed.history.version,
            ...(committed.history.note ? { note: committed.history.note } : {}),
            occurredAt: input.now,
          },
          { session },
        );
        await this.auditCollection().insertOne(
          {
            eventId: auditEventId,
            schemaVersion: 2,
            operationId: idempotencyKeyHash,
            actorUserId: input.actorUserId,
            action: committed.history.auditAction,
            targetResource: 'INCIDENT',
            targetResourceId: committed.incidentId.toHexString(),
            scope: 'PLATFORM',
            result: 'SUCCESS',
            reasonCode: committed.history.reasonCode,
            ...(committed.history.fromStatus
              ? { previousStatus: committed.history.fromStatus }
              : {}),
            newStatus: committed.history.toStatus,
            ...(input.correlationId ? { requestId: input.correlationId } : {}),
            occurredAt: input.now,
          },
          { session },
        );
        await this.operations().insertOne(
          {
            _id: new Types.ObjectId(),
            actorUserId,
            idempotencyKeyHash,
            fingerprintHash,
            operationType: input.command.command,
            incidentId: committed.incidentId,
            auditEventId,
            httpStatus: committed.httpStatus,
            resultBody: committed.body,
            committedAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          },
          { session },
        );
        result = {
          httpStatus: committed.httpStatus,
          replayed: false,
          body: committed.body,
        };
      });
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        const prior = await this.operations().findOne({
          actorUserId,
          idempotencyKeyHash,
        });
        if (prior) {
          return this.replay(prior, fingerprintHash);
        }
        throw new ConflictException({ code: 'PLATFORM_INCIDENT_CONFLICT' });
      }
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'PLATFORM_INCIDENT_MUTATION_FAILED',
      });
    } finally {
      await session.endSession();
    }
    if (!result)
      throw new InternalServerErrorException({
        code: 'PLATFORM_INCIDENT_MUTATION_FAILED',
      });
    return result;
  }

  private async applyCommand(
    input: PlatformIncidentCommandInput,
    actorUserId: Types.ObjectId,
    session: ClientSession,
  ): Promise<{
    incidentId: Types.ObjectId;
    body: PlatformIncidentSummary;
    httpStatus: 200 | 201;
    history: {
      action: IncidentHistoryDocument['action'];
      auditAction: string;
      reasonCode: string;
      fromStatus?: PlatformIncidentStatus;
      toStatus: PlatformIncidentStatus;
      version: number;
      note?: string;
    };
  }> {
    if (input.command.command === 'CREATE') {
      const incidentId = new Types.ObjectId();
      const document: IncidentDocument = {
        _id: incidentId,
        title: input.command.title,
        severity: input.command.severity,
        status: 'OPEN',
        affectedServiceId: input.command.affectedServiceId,
        version: 1,
        createdAt: input.now,
        updatedAt: input.now,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      };
      await this.incidents().insertOne(document, { session });
      return {
        incidentId,
        body: this.mapSummary(document),
        httpStatus: 201,
        history: {
          action: 'CREATED',
          auditAction: 'platform.incident.created',
          reasonCode: 'INCIDENT_CREATED',
          toStatus: 'OPEN',
          version: 1,
        },
      };
    }

    const incidentId = new Types.ObjectId(input.command.incidentId);
    const current = await this.incidents().findOne(
      { _id: incidentId },
      { session, projection: this.safeIncidentProjection() },
    );
    if (!current)
      throw new NotFoundException({ code: 'PLATFORM_INCIDENT_NOT_FOUND' });
    if (current.version !== input.command.expectedVersion)
      throw new ConflictException({
        code: 'PLATFORM_INCIDENT_VERSION_CONFLICT',
      });

    const fromStatus = current.status;
    let toStatus = fromStatus;
    let action: IncidentHistoryDocument['action'];
    let auditAction: string;
    let reasonCode: string;
    const update: Record<string, unknown> = {
      updatedAt: input.now,
      updatedBy: actorUserId,
      version: current.version + 1,
    };
    if (input.command.command === 'ACKNOWLEDGE') {
      if (fromStatus !== 'OPEN') this.invalidTransition();
      toStatus = 'ACKNOWLEDGED';
      action = 'ACKNOWLEDGED';
      auditAction = 'platform.incident.acknowledged';
      reasonCode = 'INCIDENT_ACKNOWLEDGED';
      update.status = toStatus;
      update.acknowledgedAt = input.now;
      update.acknowledgedBy = actorUserId;
    } else if (input.command.command === 'RESOLVE') {
      if (fromStatus !== 'ACKNOWLEDGED') this.invalidTransition();
      toStatus = 'RESOLVED';
      action = 'RESOLVED';
      auditAction = 'platform.incident.resolved';
      reasonCode = 'INCIDENT_RESOLVED';
      update.status = toStatus;
      update.resolvedAt = input.now;
      update.resolvedBy = actorUserId;
    } else {
      action = 'NOTE_ADDED';
      auditAction = 'platform.incident.note.added';
      reasonCode = 'OPERATIONAL_NOTE_ADDED';
    }

    const updateResult = await this.incidents().updateOne(
      {
        _id: incidentId,
        status: fromStatus,
        version: input.command.expectedVersion,
      },
      { $set: update },
      { session },
    );
    if (updateResult.modifiedCount !== 1)
      throw new ConflictException({
        code: 'PLATFORM_INCIDENT_VERSION_CONFLICT',
      });
    const updated = await this.incidents().findOne(
      { _id: incidentId },
      { session, projection: this.safeIncidentProjection() },
    );
    if (!updated)
      throw new ServiceUnavailableException({
        code: 'PLATFORM_INCIDENT_STORAGE_UNAVAILABLE',
      });
    const note = redactIncidentNote(input.command.note);
    return {
      incidentId,
      body: this.mapSummary(updated),
      httpStatus: 200,
      history: {
        action,
        auditAction,
        reasonCode,
        fromStatus,
        toStatus,
        version: updated.version,
        note,
      },
    };
  }

  private invalidTransition(): never {
    throw new ConflictException({
      code: 'PLATFORM_INCIDENT_INVALID_TRANSITION',
    });
  }

  private replay(
    prior: IncidentOperationDocument,
    fingerprintHash: string,
  ): PlatformIncidentMutationResult {
    if (prior.fingerprintHash !== fingerprintHash)
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
    if (
      !(prior.actorUserId instanceof Types.ObjectId) ||
      !(prior.incidentId instanceof Types.ObjectId) ||
      !/^[a-f\d]{64}$/.test(prior.idempotencyKeyHash) ||
      !/^[a-f\d]{64}$/.test(prior.fingerprintHash) ||
      typeof prior.auditEventId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(prior.auditEventId) ||
      !['CREATE', 'ACKNOWLEDGE', 'RESOLVE', 'ADD_NOTE'].includes(
        prior.operationType,
      ) ||
      ![200, 201].includes(prior.httpStatus)
    )
      throw new ServiceUnavailableException({
        code: 'PLATFORM_INCIDENT_STORAGE_UNAVAILABLE',
      });

    const row = prior.resultBody;
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      throw new ServiceUnavailableException({
        code: 'PLATFORM_INCIDENT_STORAGE_UNAVAILABLE',
      });
    const value = row as Record<string, unknown>;
    const isTimestamp = (candidate: unknown): candidate is string => {
      if (typeof candidate !== 'string') return false;
      const parsed = new Date(candidate);
      return (
        Number.isFinite(parsed.getTime()) && parsed.toISOString() === candidate
      );
    };
    if (
      value.id !== prior.incidentId.toHexString() ||
      typeof value.title !== 'string' ||
      value.title.length < 1 ||
      value.title.length > 160 ||
      !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(
        value.severity as string,
      ) ||
      !['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(value.status as string) ||
      !(PLATFORM_SERVICE_IDS as readonly string[]).includes(
        value.affectedServiceId as string,
      ) ||
      !Number.isSafeInteger(value.version) ||
      (value.version as number) < 1 ||
      !isTimestamp(value.createdAt) ||
      !isTimestamp(value.updatedAt) ||
      typeof value.createdBy !== 'string' ||
      !/^[a-f\d]{24}$/i.test(value.createdBy) ||
      typeof value.updatedBy !== 'string' ||
      !/^[a-f\d]{24}$/i.test(value.updatedBy) ||
      !(value.acknowledgedAt === null || isTimestamp(value.acknowledgedAt)) ||
      !(value.resolvedAt === null || isTimestamp(value.resolvedAt)) ||
      (prior.operationType === 'CREATE' && prior.httpStatus !== 201) ||
      (prior.operationType !== 'CREATE' && prior.httpStatus !== 200)
    )
      throw new ServiceUnavailableException({
        code: 'PLATFORM_INCIDENT_STORAGE_UNAVAILABLE',
      });

    const body: PlatformIncidentSummary = {
      id: value.id,
      title: value.title,
      severity: value.severity as PlatformIncidentSummary['severity'],
      status: value.status as PlatformIncidentSummary['status'],
      affectedServiceId: value.affectedServiceId as string,
      version: value.version as number,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      createdBy: value.createdBy,
      updatedBy: value.updatedBy,
      acknowledgedAt: value.acknowledgedAt,
      resolvedAt: value.resolvedAt,
    };
    return {
      httpStatus: prior.httpStatus,
      replayed: true,
      body,
    };
  }

  private async acquireAuthorityFence(session: ClientSession): Promise<void> {
    const result = await this.model<{ _id: Types.ObjectId }>(
      'platform_authority_change_locks',
    )
      .updateOne(
        {
          permission: commonPlatformAuthorityFence,
          scope: 'PLATFORM',
        },
        { $inc: { version: 1 } },
        { session },
      )
      .exec();
    if (result.matchedCount !== 1)
      throw new ServiceUnavailableException({
        code: 'PLATFORM_AUTHORITY_LOCKS_UNAVAILABLE',
      });
  }

  private async hasPermission(
    actorUserId: Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<boolean> {
    const actor = await this.model<{ _id: Types.ObjectId }>('users')
      .findOne({ _id: actorUserId, status: 'ACTIVE' }, { _id: 1 })
      .session(session)
      .lean()
      .exec();
    if (!actor) return false;
    const assignments = await this.model<{
      _id: Types.ObjectId;
      subjectUserId: Types.ObjectId;
      permission: string;
      scope: string;
      status: string;
      grantedBy: Types.ObjectId;
      grantedAt: Date;
      expiresAt?: Date | null;
      revokedAt?: Date | null;
    }>('platform_authority_assignments')
      .find({
        subjectUserId: actorUserId,
        permission: incidentPermission,
        scope: 'PLATFORM',
      })
      .session(session)
      .lean()
      .exec();
    const active = assignments.filter(
      (assignment) =>
        assignment.subjectUserId.equals(actorUserId) &&
        assignment.permission === incidentPermission &&
        assignment.scope === 'PLATFORM' &&
        assignment.status === 'ACTIVE' &&
        assignment.revokedAt == null &&
        assignment.grantedBy instanceof Types.ObjectId &&
        !assignment.grantedBy.equals(actorUserId) &&
        assignment.grantedAt instanceof Date &&
        Number.isFinite(assignment.grantedAt.getTime()) &&
        assignment.grantedAt.getTime() <= now.getTime() &&
        (assignment.expiresAt == null ||
          (assignment.expiresAt instanceof Date &&
            Number.isFinite(assignment.expiresAt.getTime()) &&
            assignment.expiresAt.getTime() > now.getTime())),
    );
    return active.length === 1;
  }

  private mapSummary(row: IncidentDocument): PlatformIncidentSummary {
    if (
      !(row._id instanceof Types.ObjectId) ||
      typeof row.title !== 'string' ||
      !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(row.severity) ||
      !['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(row.status) ||
      typeof row.affectedServiceId !== 'string' ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      !(row.createdAt instanceof Date) ||
      !(row.updatedAt instanceof Date) ||
      !(row.createdBy instanceof Types.ObjectId) ||
      !(row.updatedBy instanceof Types.ObjectId)
    )
      throw new ServiceUnavailableException({
        code: 'PLATFORM_INCIDENT_STORAGE_UNAVAILABLE',
      });
    return {
      id: row._id.toHexString(),
      title: row.title,
      severity: row.severity,
      status: row.status,
      affectedServiceId: row.affectedServiceId,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdBy: row.createdBy.toHexString(),
      updatedBy: row.updatedBy.toHexString(),
      acknowledgedAt:
        row.acknowledgedAt instanceof Date
          ? row.acknowledgedAt.toISOString()
          : null,
      resolvedAt:
        row.resolvedAt instanceof Date ? row.resolvedAt.toISOString() : null,
    };
  }

  private mapHistory(
    row: IncidentHistoryDocument,
  ): PlatformIncidentHistoryItem {
    if (
      !(row._id instanceof Types.ObjectId) ||
      !(row.incidentId instanceof Types.ObjectId) ||
      !(row.actorUserId instanceof Types.ObjectId) ||
      !(row.occurredAt instanceof Date) ||
      !Number.isSafeInteger(row.version) ||
      !['CREATED', 'ACKNOWLEDGED', 'RESOLVED', 'NOTE_ADDED'].includes(
        row.action,
      ) ||
      !['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(row.toStatus)
    )
      throw new ServiceUnavailableException({
        code: 'PLATFORM_INCIDENT_STORAGE_UNAVAILABLE',
      });
    return {
      id: row._id.toHexString(),
      incidentId: row.incidentId.toHexString(),
      action: row.action,
      ...(row.fromStatus ? { fromStatus: row.fromStatus } : {}),
      toStatus: row.toStatus,
      version: row.version,
      actorUserId: row.actorUserId.toHexString(),
      occurredAt: row.occurredAt.toISOString(),
      ...(typeof row.note === 'string'
        ? { note: redactIncidentNote(row.note) }
        : {}),
    };
  }

  private page<T>(
    data: T[],
    page: number,
    pageSize: number,
    totalItems: number,
  ): PlatformIncidentPage<T> {
    return {
      data,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  private safeIncidentProjection(): Record<string, 1> {
    return {
      _id: 1,
      title: 1,
      severity: 1,
      status: 1,
      affectedServiceId: 1,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      createdBy: 1,
      updatedBy: 1,
      acknowledgedAt: 1,
      resolvedAt: 1,
    };
  }

  private incidents() {
    return this.connectionOrThrow().collection<IncidentDocument>(
      'platform_incidents',
    );
  }

  private history() {
    return this.connectionOrThrow().collection<IncidentHistoryDocument>(
      'platform_incident_history',
    );
  }

  private operations() {
    return this.connectionOrThrow().collection<IncidentOperationDocument>(
      'platform_incident_operations',
    );
  }

  private auditCollection() {
    return this.connectionOrThrow()
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME);
  }

  private model<T>(name: string) {
    const model = this.connectionOrThrow().models[modelName(name)] as
      Model<T> | undefined;
    if (!model)
      throw new ServiceUnavailableException({
        code: 'PLATFORM_INCIDENT_STORAGE_UNAVAILABLE',
      });
    return model;
  }

  private connectionOrThrow(): Connection {
    if (!this.connection)
      throw new ServiceUnavailableException({
        code: 'PLATFORM_INCIDENT_STORAGE_UNAVAILABLE',
      });
    return this.connection;
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}

export { PLATFORM_INCIDENT_REPOSITORY };
