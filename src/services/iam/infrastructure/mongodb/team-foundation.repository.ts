import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import type { Collection, Document } from 'mongodb';
import { TeamAuthorizationPolicy } from '../../application/teams/team-authorization.policy';
import {
  parseIdempotencyKey,
  parseIfMatch,
  type TeamCreateInput,
  type TeamListQuery,
  type TeamUpdateInput,
} from '../../application/teams/team-contract';
import type {
  TeamCommandResult,
  TeamFoundationRepository,
  TeamListResult,
  TeamRecord,
} from '../../application/teams/team.repository';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import { IAM_PERSISTENCE } from '../persistence';
import { TeamAuthorizationEvidence } from './team-foundation.authorization-evidence';
import {
  IdempotencySlotRace,
  actionForbidden,
  policyNotReady,
  projectNotFound,
  retryLater,
  teamCodeConflict,
  teamNotFound,
} from './team-foundation.repository-errors';
import {
  modelName,
  objectId,
  validId,
  type AuthorizationFacts,
  type MutationCommand,
  type PendingResult,
  type ReadinessIndex,
  type TeamDocument,
  type TeamOperationDocument,
} from './team-foundation.repository.types';

const keyFingerprint = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const keyHash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date)
    return left.getTime() === right.getTime();
  if (left instanceof Types.ObjectId && right instanceof Types.ObjectId)
    return left.equals(right);
  return left === right;
}

@Injectable()
export class MongoTeamFoundationRepository implements TeamFoundationRepository {
  private readonly authorizationEvidence: TeamAuthorizationEvidence;

  constructor(
    private readonly authorizationPolicy: TeamAuthorizationPolicy,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {
    this.authorizationEvidence = new TeamAuthorizationEvidence(
      authorizationPolicy,
      connection,
    );
  }

  create(
    organizationId: string,
    actorUserId: string,
    projectId: string,
    input: TeamCreateInput,
    idempotencyKey: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.mutate({
      organizationId,
      actorUserId,
      method: 'POST',
      path: `/api/v1/iam/projects/${projectId.toLowerCase()}/teams`,
      permission: 'team.create',
      idempotencyKey,
      body: input as unknown as Record<string, unknown>,
      projectId,
    });
  }

  update(
    organizationId: string,
    actorUserId: string,
    teamId: string,
    input: TeamUpdateInput,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.mutate({
      organizationId,
      actorUserId,
      method: 'PATCH',
      path: `/api/v1/iam/teams/${teamId.toLowerCase()}`,
      permission: 'team.update',
      idempotencyKey,
      ifMatch,
      body: input as unknown as Record<string, unknown>,
      teamId,
    });
  }

  archive(
    organizationId: string,
    actorUserId: string,
    teamId: string,
    reason: string,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.mutate({
      organizationId,
      actorUserId,
      method: 'POST',
      path: `/api/v1/iam/teams/${teamId.toLowerCase()}/archive`,
      permission: 'team.archive',
      idempotencyKey,
      ifMatch,
      body: { reason },
      teamId,
    });
  }

  restore(
    organizationId: string,
    actorUserId: string,
    teamId: string,
    reason: string,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.mutate({
      organizationId,
      actorUserId,
      method: 'POST',
      path: `/api/v1/iam/teams/${teamId.toLowerCase()}/restore`,
      permission: 'team.restore',
      idempotencyKey,
      ifMatch,
      body: { reason },
      teamId,
    });
  }

  async list(
    organizationId: string,
    actorUserId: string,
    projectId: string,
    query: TeamListQuery,
  ): Promise<TeamListResult> {
    if (
      !validId(organizationId) ||
      !validId(actorUserId) ||
      !validId(projectId)
    )
      throw projectNotFound();
    const facts = await this.authorizationEvidence.load(
      organizationId,
      actorUserId,
      projectId,
    );
    const projectMember = this.authorizationEvidence.hasActiveProjectAccess(
      facts,
      organizationId,
      actorUserId,
      projectId,
    );
    if (!projectMember) throw projectNotFound();

    const manager = this.authorizationPolicy.evaluate(
      this.authorizationEvidence.authorizationInput(
        facts,
        organizationId,
        actorUserId,
        projectId,
        'team.read',
      ),
    );
    if (!manager.allowed || manager.access !== 'MANAGER')
      throw actionForbidden();

    const filter = {
      organizationId: objectId(organizationId),
      projectId: objectId(projectId),
      status: {
        $in: query.status === 'ALL' ? ['ACTIVE', 'ARCHIVED'] : [query.status],
      },
    };
    const teams = this.model<TeamDocument>('teams');
    const [rows, totalItems] = await Promise.all([
      teams
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean()
        .exec(),
      teams.countDocuments(filter).exec(),
    ]);
    return {
      data: rows.map((row) => this.toRecord(row)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  async get(
    organizationId: string,
    actorUserId: string,
    teamId: string,
  ): Promise<TeamRecord> {
    if (!validId(organizationId) || !validId(actorUserId) || !validId(teamId))
      throw teamNotFound();
    const team = await this.rawTeams().findOne({
      _id: objectId(teamId),
      organizationId: objectId(organizationId),
    });
    if (!team) throw teamNotFound();
    if (!(team.projectId instanceof Types.ObjectId)) throw teamNotFound();
    const projectId = String(team.projectId);
    let facts: AuthorizationFacts;
    try {
      facts = await this.authorizationEvidence.load(
        organizationId,
        actorUserId,
        projectId,
      );
    } catch (error) {
      if (error instanceof NotFoundException) throw teamNotFound();
      throw error;
    }
    if (
      !facts ||
      !this.authorizationEvidence.hasActiveProjectAccess(
        facts,
        organizationId,
        actorUserId,
        projectId,
      )
    )
      throw teamNotFound();
    const access = this.authorizationPolicy.evaluate(
      this.authorizationEvidence.authorizationInput(
        facts,
        organizationId,
        actorUserId,
        projectId,
        'team.read',
      ),
    );
    if (!access.allowed || access.access !== 'MANAGER') throw teamNotFound();
    return this.toRecord(team);
  }

  private async mutate(command: MutationCommand): Promise<TeamCommandResult> {
    if (
      !validId(command.organizationId) ||
      !validId(command.actorUserId) ||
      (command.projectId !== undefined && !validId(command.projectId)) ||
      (command.teamId !== undefined && !validId(command.teamId))
    )
      throw command.projectId ? projectNotFound() : teamNotFound();

    const connection = this.requireConnection();
    await this.authorizeMutation(command);
    parseIdempotencyKey(command.idempotencyKey);
    if (command.teamId !== undefined)
      parseIfMatch(command.ifMatch, command.teamId);
    const readiness = await this.ensureMutationReady();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await connection.startSession();
      let result: TeamCommandResult | undefined;
      try {
        await session.withTransaction(
          async () => {
            result = await this.executeMutation(command, session, readiness);
          },
          {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
            readPreference: 'primary',
          },
        );
        if (!result) throw new Error('Team transaction returned no result');
        return result;
      } catch (error) {
        if (error instanceof IdempotencySlotRace) {
          if (attempt < 2) continue;
          throw retryLater();
        }
        if (this.isUnknownCommit(error)) throw retryLater();
        if (this.isCodeConflict(error)) throw teamCodeConflict();
        if (this.isIdempotencyIndexConflict(error)) {
          if (attempt < 2) continue;
          throw retryLater();
        }
        throw error;
      } finally {
        await session.endSession();
      }
    }
    throw retryLater();
  }

  private async executeMutation(
    command: MutationCommand,
    session: ClientSession,
    readiness: {
      operations: Collection<TeamOperationDocument>;
      audit: Collection<Document>;
    },
  ): Promise<TeamCommandResult> {
    const { isCreate, projectId, currentTeam, facts } =
      await this.authorizeMutation(command, session);

    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    const precondition = isCreate
      ? undefined
      : parseIfMatch(command.ifMatch, command.teamId!);
    const fingerprint = keyFingerprint({
      method: command.method,
      path: command.path,
      body: command.body,
      precondition: precondition ?? null,
    });
    await this.authorizationEvidence.fenceAuthorization(
      facts,
      command,
      projectId,
      session,
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const scope = {
      organizationId: objectId(command.organizationId),
      actorUserId: objectId(command.actorUserId),
      keyHash: keyHash(idempotencyKey),
    };
    const existing = await readiness.operations.findOne(scope, { session });
    const commandId = new Types.ObjectId().toHexString();
    const operationSeed: TeamOperationDocument = {
      _id: new Types.ObjectId(),
      ...scope,
      fingerprint,
      status: 'IN_PROGRESS',
      commandId,
      expiresAt,
    };
    if (existing) {
      if (existing.expiresAt.getTime() > now.getTime()) {
        if (existing.fingerprint !== fingerprint)
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency-Key was used for a different command.',
          });
        if (
          existing.status !== 'COMMITTED' ||
          !existing.responseBody ||
          !existing.etag ||
          !existing.httpStatus
        )
          throw retryLater();
        return {
          statusCode: existing.httpStatus as 200 | 201,
          team: existing.responseBody,
          etag: existing.etag,
          ...(existing.location ? { location: existing.location } : {}),
          replayed: true,
        };
      }
      operationSeed._id = existing._id;
      operationSeed.commandId = commandId;
      const replaced = await readiness.operations.replaceOne(
        { _id: existing._id, status: 'COMMITTED', expiresAt: { $lte: now } },
        operationSeed,
        { session },
      );
      if (replaced.modifiedCount !== 1) throw new IdempotencySlotRace();
    } else {
      await readiness.operations.insertOne(operationSeed, { session });
    }

    if (precondition && currentTeam?.version !== precondition.version)
      throw new HttpException(
        { code: 'PRECONDITION_FAILED', message: 'Team version is stale.' },
        412,
      );

    const pending = isCreate
      ? await this.createTeam(command, projectId, now, session)
      : await this.changeTeam(
          command,
          currentTeam!,
          projectId,
          commandId,
          now,
          session,
        );

    if (pending.changed && pending.audit) {
      await readiness.audit.insertOne(
        this.auditRecord(command, pending.team, commandId, pending.audit, now),
        { session },
      );
    }
    const stored: Partial<TeamOperationDocument> = {
      status: 'COMMITTED',
      httpStatus: pending.statusCode,
      responseBody: pending.team,
      etag: pending.etag,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      ...(pending.location ? { location: pending.location } : {}),
    };
    const storedResult = await readiness.operations.updateOne(
      { ...scope, commandId, status: 'IN_PROGRESS' },
      { $set: stored },
      { session },
    );
    if (storedResult.modifiedCount !== 1) throw new IdempotencySlotRace();
    return {
      statusCode: pending.statusCode,
      team: pending.team,
      etag: pending.etag,
      ...(pending.location ? { location: pending.location } : {}),
      replayed: false,
    };
  }

  private async authorizeMutation(
    command: MutationCommand,
    session?: ClientSession,
  ): Promise<{
    isCreate: boolean;
    projectId: string;
    currentTeam: TeamDocument | null;
    facts: AuthorizationFacts;
  }> {
    const isCreate = command.teamId === undefined;
    let currentTeam: TeamDocument | null = null;
    let projectId = command.projectId!;
    if (!isCreate) {
      const raw = await this.rawTeams().findOne(
        {
          _id: objectId(command.teamId!),
          organizationId: objectId(command.organizationId),
        },
        session ? { session } : {},
      );
      if (!raw) throw teamNotFound();
      currentTeam = raw;
      if (!(currentTeam.projectId instanceof Types.ObjectId))
        throw teamNotFound();
      projectId = String(currentTeam.projectId);
    }

    const facts = await this.authorizationEvidence
      .load(command.organizationId, command.actorUserId, projectId, session)
      .catch((error: unknown) => {
        if (error instanceof NotFoundException) {
          if (isCreate) throw error;
          throw teamNotFound();
        }
        throw policyNotReady();
      });
    if (
      !this.authorizationEvidence.hasActiveProjectAccess(
        facts,
        command.organizationId,
        command.actorUserId,
        projectId,
      )
    )
      throw isCreate ? projectNotFound() : teamNotFound();

    if (currentTeam) {
      const visible = this.authorizationPolicy.evaluate(
        this.authorizationEvidence.authorizationInput(
          facts,
          command.organizationId,
          command.actorUserId,
          projectId,
          'team.read',
        ),
      );
      if (!visible.allowed || visible.access !== 'MANAGER')
        throw teamNotFound();
    }

    const action = this.authorizationPolicy.evaluate(
      this.authorizationEvidence.authorizationInput(
        facts,
        command.organizationId,
        command.actorUserId,
        projectId,
        command.permission,
      ),
    );
    if (!action.allowed || action.access !== 'MANAGER') throw actionForbidden();
    if (currentTeam && !this.isTeamRuntimeRecord(currentTeam))
      throw policyNotReady();

    return { isCreate, projectId, currentTeam, facts };
  }

  private async createTeam(
    command: MutationCommand,
    projectId: string,
    now: Date,
    session: ClientSession,
  ): Promise<PendingResult> {
    const input = command.body as unknown as TeamCreateInput;
    const row: TeamDocument = {
      _id: new Types.ObjectId(),
      organizationId: objectId(command.organizationId),
      projectId: objectId(projectId),
      name: input.name,
      code: input.code,
      description: input.description,
      status: 'ACTIVE',
      version: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      archivedBy: null,
      archivedReason: null,
    };
    await this.rawTeams().insertOne(row, { session });
    const team = this.toRecord(row);
    return {
      statusCode: 201,
      team,
      etag: this.etag(team),
      location: `/api/v1/iam/teams/${team.id}`,
      changed: true,
      audit: {
        action: 'team.create',
        oldVersion: null,
        newVersion: 1,
        changedFields: ['name', 'code', 'description', 'status'],
      },
    };
  }

  private async changeTeam(
    command: MutationCommand,
    current: TeamDocument,
    projectId: string,
    commandId: string,
    now: Date,
    session: ClientSession,
  ): Promise<PendingResult> {
    if (command.permission === 'team.update' && current.status !== 'ACTIVE')
      throw new ConflictException({
        code: 'TEAM_ARCHIVED',
        message: 'Archived Teams cannot be updated.',
      });
    const next: Record<string, unknown> = {};
    let action: NonNullable<PendingResult['audit']>['action'] = 'team.update';
    let changedFields: string[] = [];
    if (command.permission === 'team.update') {
      const input = command.body as unknown as TeamUpdateInput;
      if (input.name !== undefined) next.name = input.name;
      if (input.description !== undefined) next.description = input.description;
      action = 'team.update';
      changedFields = ['name', 'description'].filter((field) =>
        Object.hasOwn(next, field),
      );
    } else if (command.permission === 'team.archive') {
      action = 'team.archive';
      if (current.status === 'ACTIVE') {
        next.status = 'ARCHIVED';
        next.archivedAt = now;
        next.archivedBy = objectId(command.actorUserId);
        next.archivedReason = String(command.body.reason);
      }
      changedFields = ['status', 'archivedAt', 'archivedBy', 'archivedReason'];
    } else {
      action = 'team.restore';
      if (current.status === 'ARCHIVED') {
        next.status = 'ACTIVE';
        next.archivedAt = null;
        next.archivedBy = null;
        next.archivedReason = null;
      }
      changedFields = ['status', 'archivedAt', 'archivedBy', 'archivedReason'];
    }
    const changed = Object.entries(next).some(
      ([key, value]) => !sameValue(current[key as keyof TeamDocument], value),
    );
    if (!changed) {
      const team = this.toRecord(current);
      return {
        statusCode: 200,
        team,
        etag: this.etag(team),
        changed: false,
      };
    }
    const newVersion = current.version + 1;
    if (!Number.isSafeInteger(newVersion)) throw policyNotReady();
    const updated = await this.rawTeams().findOneAndUpdate(
      {
        _id: current._id,
        organizationId: objectId(command.organizationId),
        projectId: objectId(projectId),
        status: current.status,
        version: current.version,
      },
      {
        $set: { ...next, version: newVersion, updatedAt: now },
      },
      { session, returnDocument: 'after', includeResultMetadata: true },
    );
    const row = updated?.value ?? null;
    if (!row)
      throw new HttpException(
        { code: 'PRECONDITION_FAILED', message: 'Team changed concurrently.' },
        412,
      );
    const team = this.toRecord(row);
    return {
      statusCode: 200,
      team,
      etag: this.etag(team),
      changed: true,
      audit: {
        action,
        oldVersion: current.version,
        newVersion,
        changedFields,
      },
    };
  }

  private auditRecord(
    command: MutationCommand,
    team: TeamRecord,
    commandId: string,
    event: NonNullable<PendingResult['audit']>,
    occurredAt: Date,
  ): Document {
    return {
      organizationId: command.organizationId,
      projectId: team.projectId,
      actorUserId: command.actorUserId,
      action: event.action,
      targetResource: 'TEAM',
      targetResourceId: team.id,
      occurredAt,
      metadata: {
        teamId: team.id,
        commandId,
        oldVersion: event.oldVersion,
        newVersion: event.newVersion,
        changedFields: event.changedFields,
      },
    };
  }

  private async ensureMutationReady(): Promise<{
    operations: Collection<TeamOperationDocument>;
    audit: Collection<Document>;
  }> {
    const connection = this.requireConnection();
    if (!connection.db) throw policyNotReady();
    const operationName = 'team_operations';
    const auditName = IAM_AUDIT_COLLECTION_NAME;
    const auditConnection = connection.useDb(AUDIT_DATABASE_NAME, {
      useCache: true,
    });
    if (!auditConnection.db) throw policyNotReady();
    const [operationCollections, auditCollections] = await Promise.all([
      connection.db
        .listCollections({ name: operationName }, { nameOnly: true })
        .toArray(),
      auditConnection.db
        .listCollections({ name: auditName }, { nameOnly: true })
        .toArray(),
    ]);
    const operationCollection = operationCollections.length > 0;
    const auditCollection = auditCollections.length > 0;
    if (!operationCollection || !auditCollection) throw policyNotReady();
    const operations =
      connection.db.collection<TeamOperationDocument>(operationName);
    const audit = auditConnection.db.collection<Document>(auditName);
    const [operationIndexesRaw, auditIndexesRaw, teamIndexesRaw] =
      await Promise.all([
        operations.listIndexes().toArray(),
        audit.listIndexes().toArray(),
        this.rawTeams().listIndexes().toArray(),
      ]);
    const operationIndexes = operationIndexesRaw as unknown as ReadinessIndex[];
    const auditIndexes = auditIndexesRaw as unknown as ReadinessIndex[];
    const teamIndexes = teamIndexesRaw as unknown as ReadinessIndex[];
    const hasOperationKey = operationIndexes.some(
      (index) =>
        index.unique === true &&
        this.isUnfilteredIndex(index) &&
        this.sameIndex(index.key, {
          organizationId: 1,
          actorUserId: 1,
          keyHash: 1,
        }),
    );
    const hasOperationExpiry = operationIndexes.some(
      (index) =>
        index.expireAfterSeconds === 0 &&
        this.isUnfilteredIndex(index) &&
        this.sameIndex(index.key, { expiresAt: 1 }),
    );
    const hasTeamCodeUnique = teamIndexes.some(
      (index) =>
        index.unique === true &&
        this.isUnfilteredIndex(index) &&
        this.sameIndex(index.key, {
          organizationId: 1,
          projectId: 1,
          code: 1,
        }),
    );
    const hasAuditDedupe = auditIndexes.some((index) => {
      const partial = index.partialFilterExpression;
      const commandIdFilter = partial?.['metadata.commandId'];
      const commandIdExists =
        typeof commandIdFilter === 'object' &&
        commandIdFilter !== null &&
        '$exists' in commandIdFilter &&
        commandIdFilter.$exists === true;
      return (
        index.unique === true &&
        index.sparse !== true &&
        index.hidden !== true &&
        index.collation === undefined &&
        this.sameIndex(index.key, {
          organizationId: 1,
          'metadata.commandId': 1,
          action: 1,
          targetResourceId: 1,
        }) &&
        partial !== undefined &&
        Object.keys(partial).length === 2 &&
        typeof commandIdFilter === 'object' &&
        commandIdFilter !== null &&
        Object.keys(commandIdFilter).length === 1 &&
        partial?.targetResource === 'TEAM' &&
        commandIdExists
      );
    });
    if (
      !hasOperationKey ||
      !hasOperationExpiry ||
      !hasTeamCodeUnique ||
      !hasAuditDedupe
    )
      throw policyNotReady();
    return { operations, audit };
  }

  private sameIndex(left: unknown, right: Record<string, 1 | -1>): boolean {
    if (!left || typeof left !== 'object') return false;
    const entries = Object.entries(left as Record<string, unknown>);
    return (
      entries.length === Object.keys(right).length &&
      entries.every(([key, value]) => right[key] === value)
    );
  }

  private isUnfilteredIndex(index: ReadinessIndex): boolean {
    return (
      index.partialFilterExpression === undefined &&
      index.sparse !== true &&
      index.hidden !== true &&
      index.collation === undefined
    );
  }

  private isTeamRuntimeRecord(row: TeamDocument): boolean {
    return (
      row.organizationId instanceof Types.ObjectId &&
      row.projectId instanceof Types.ObjectId &&
      this.isCanonicalName(row.name) &&
      this.isCanonicalCode(row.code) &&
      this.isValidDescription(row.description) &&
      ['ACTIVE', 'ARCHIVED'].includes(row.status) &&
      Number.isSafeInteger(row.version) &&
      row.version >= 1 &&
      row.createdAt instanceof Date &&
      Number.isFinite(row.createdAt.getTime()) &&
      row.updatedAt instanceof Date &&
      Number.isFinite(row.updatedAt.getTime()) &&
      (row.status === 'ACTIVE'
        ? row.archivedAt === null &&
          row.archivedBy === null &&
          row.archivedReason === null
        : row.archivedAt instanceof Date &&
          Number.isFinite(row.archivedAt.getTime()) &&
          row.archivedBy instanceof Types.ObjectId &&
          this.isCanonicalReason(row.archivedReason))
    );
  }

  private hasControls(value: string, allowLayout = false): boolean {
    for (const character of value) {
      const codePoint = character.codePointAt(0)!;
      if (
        codePoint === 0x7f ||
        (codePoint < 0x20 &&
          !(allowLayout && (codePoint === 0x09 || codePoint === 0x0a)))
      )
        return true;
    }
    return false;
  }

  private isCanonicalName(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const normalized = value.normalize('NFC').trim();
    return (
      normalized === value &&
      [...value].length >= 1 &&
      [...value].length <= 200 &&
      !this.hasControls(value)
    );
  }

  private isCanonicalCode(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value === value.trim() &&
      value === value.toUpperCase() &&
      /^[A-Z][A-Z0-9_-]{1,31}$/.test(value)
    );
  }

  private isValidDescription(value: unknown): value is string | null {
    return (
      value === null ||
      (typeof value === 'string' &&
        [...value].length <= 2000 &&
        !this.hasControls(value, true))
    );
  }

  private isCanonicalReason(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value === value.trim() &&
      [...value].length >= 1 &&
      [...value].length <= 500 &&
      !this.hasControls(value)
    );
  }

  private toRecord(row: TeamDocument): TeamRecord {
    if (!this.isTeamRuntimeRecord(row)) throw policyNotReady();
    return {
      id: String(row._id),
      organizationId: String(row.organizationId),
      projectId: String(row.projectId),
      name: row.name,
      code: row.code,
      description: row.description,
      status: row.status,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      archivedBy: row.archivedBy ? String(row.archivedBy) : null,
    };
  }

  private etag(team: TeamRecord): string {
    return `"team:${team.id}:${team.version}"`;
  }

  private isCodeConflict(error: unknown): boolean {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 11000
    )
      return false;
    const pattern = 'keyPattern' in error ? error.keyPattern : undefined;
    return Boolean(pattern && typeof pattern === 'object' && 'code' in pattern);
  }

  private isIdempotencyIndexConflict(error: unknown): boolean {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 11000
    )
      return false;
    const pattern = 'keyPattern' in error ? error.keyPattern : undefined;
    return Boolean(
      pattern &&
      typeof pattern === 'object' &&
      'organizationId' in pattern &&
      'actorUserId' in pattern &&
      'keyHash' in pattern,
    );
  }

  private isUnknownCommit(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    if ('hasErrorLabel' in error && typeof error.hasErrorLabel === 'function') {
      const candidate = error as { hasErrorLabel: (label: string) => boolean };
      return (
        candidate.hasErrorLabel('UnknownTransactionCommitResult') ||
        candidate.hasErrorLabel('TransientTransactionError')
      );
    }
    const labels = 'errorLabels' in error ? error.errorLabels : undefined;
    return (
      Array.isArray(labels) &&
      labels.some((label) =>
        [
          'UnknownTransactionCommitResult',
          'TransientTransactionError',
        ].includes(String(label)),
      )
    );
  }

  private requireConnection(): Connection {
    if (!this.connection) throw policyNotReady();
    return this.connection;
  }

  private model<T>(collection: string): Model<T> {
    const model = this.connection?.models[modelName(collection)] as
      Model<T> | undefined;
    if (!model) throw policyNotReady();
    return model;
  }

  private rawTeams(): Collection<TeamDocument> {
    return this.model<TeamDocument>('teams')
      .collection as unknown as Collection<TeamDocument>;
  }
}
