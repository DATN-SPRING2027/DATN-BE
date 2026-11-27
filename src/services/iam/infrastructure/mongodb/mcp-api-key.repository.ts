import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import type {
  CreateMcpApiKeyRecordInput,
  McpApiKeyRecord,
  McpApiKeyRepositoryPort,
} from '../../application/mcp-api-keys/mcp-api-key.repository';
import type { McpKeyScopeMode } from '../../application/mcp-api-keys/mcp-api-key.types';
import { IAM_PERSISTENCE } from '../persistence';

interface McpApiKeyDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scope: McpKeyScopeMode;
  allowedProjectIds: string[] | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MCP_API_KEYS_MODEL = `${IAM_PERSISTENCE.databaseName}_mcp_api_keys`;

@Injectable()
export class MongoMcpApiKeyRepository implements McpApiKeyRepositoryPort {
  private readonly logger = new Logger(MongoMcpApiKeyRepository.name);
  private readonly memoryById = new Map<string, McpApiKeyRecord>();
  private readonly memoryIdByHash = new Map<string, string>();
  private loggedInMemoryFallback = false;

  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  private resolveModel(): Model<McpApiKeyDocument> | null {
    if (!this.connection) {
      if (!this.loggedInMemoryFallback) {
        this.loggedInMemoryFallback = true;
        this.logger.debug(
          'MongoDB connection unavailable (INFRA_ENABLED=false); using in-memory MCP API key store.',
        );
      }
      return null;
    }
    const model = this.connection.models[MCP_API_KEYS_MODEL] as
      Model<McpApiKeyDocument> | undefined;
    if (!model) {
      throw new Error(`Mongoose model ${MCP_API_KEYS_MODEL} is not registered`);
    }
    return model;
  }

  private cloneRecord(record: McpApiKeyRecord): McpApiKeyRecord {
    return {
      ...record,
      allowedProjectIds: record.allowedProjectIds
        ? [...record.allowedProjectIds]
        : null,
      expiresAt: record.expiresAt ? new Date(record.expiresAt.getTime()) : null,
      revokedAt: record.revokedAt ? new Date(record.revokedAt.getTime()) : null,
      lastUsedAt: record.lastUsedAt
        ? new Date(record.lastUsedAt.getTime())
        : null,
      createdAt: new Date(record.createdAt.getTime()),
      updatedAt: new Date(record.updatedAt.getTime()),
    };
  }

  private toRecord(doc: McpApiKeyDocument): McpApiKeyRecord {
    return {
      id: String(doc._id).toLowerCase(),
      organizationId: String(doc.organizationId).toLowerCase(),
      userId: String(doc.userId).toLowerCase(),
      name: doc.name,
      keyHash: doc.keyHash,
      keyPrefix: doc.keyPrefix,
      scope: doc.scope,
      allowedProjectIds: Array.isArray(doc.allowedProjectIds)
        ? doc.allowedProjectIds.map((id) => String(id).toLowerCase())
        : null,
      expiresAt: doc.expiresAt instanceof Date ? doc.expiresAt : null,
      revokedAt: doc.revokedAt instanceof Date ? doc.revokedAt : null,
      lastUsedAt: doc.lastUsedAt instanceof Date ? doc.lastUsedAt : null,
      createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(0),
      updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(0),
    };
  }

  async create(input: CreateMcpApiKeyRecordInput): Promise<McpApiKeyRecord> {
    const model = this.resolveModel();
    if (!model) {
      if (this.memoryIdByHash.has(input.keyHash)) {
        throw new Error('Duplicate MCP API key hash');
      }
      const id = new Types.ObjectId().toHexString();
      const record: McpApiKeyRecord = {
        id,
        organizationId: input.organizationId.toLowerCase(),
        userId: input.userId.toLowerCase(),
        name: input.name,
        keyHash: input.keyHash,
        keyPrefix: input.keyPrefix,
        scope: input.scope,
        allowedProjectIds: input.allowedProjectIds
          ? [...input.allowedProjectIds]
          : null,
        expiresAt: input.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(input.now.getTime()),
        updatedAt: new Date(input.now.getTime()),
      };
      this.memoryById.set(id, record);
      this.memoryIdByHash.set(input.keyHash, id);
      return this.cloneRecord(record);
    }

    const created = await model.create({
      organizationId: new Types.ObjectId(input.organizationId.toLowerCase()),
      userId: new Types.ObjectId(input.userId.toLowerCase()),
      name: input.name,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      scope: input.scope,
      allowedProjectIds: input.allowedProjectIds,
      expiresAt: input.expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    });
    return this.toRecord(created.toObject());
  }

  async listByUserAndOrganization(
    userId: string,
    organizationId: string,
  ): Promise<McpApiKeyRecord[]> {
    const normalizedUserId = userId.toLowerCase();
    const normalizedOrgId = organizationId.toLowerCase();
    const model = this.resolveModel();
    if (!model) {
      return [...this.memoryById.values()]
        .filter(
          (row) =>
            row.userId === normalizedUserId &&
            row.organizationId === normalizedOrgId,
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.id.localeCompare(a.id),
        )
        .map((row) => this.cloneRecord(row));
    }

    if (
      !Types.ObjectId.isValid(normalizedUserId) ||
      !Types.ObjectId.isValid(normalizedOrgId)
    ) {
      return [];
    }

    const rows = await model
      .find({
        organizationId: new Types.ObjectId(normalizedOrgId),
        userId: new Types.ObjectId(normalizedUserId),
      })
      .sort({ createdAt: -1, _id: -1 })
      .lean<McpApiKeyDocument[]>()
      .exec();

    return rows.map((row) => this.toRecord(row));
  }

  async findByKeyHash(keyHash: string): Promise<McpApiKeyRecord | null> {
    if (!/^[a-f\d]{64}$/i.test(keyHash)) {
      return null;
    }
    const normalizedHash = keyHash.toLowerCase();
    const model = this.resolveModel();
    if (!model) {
      const id = this.memoryIdByHash.get(normalizedHash);
      if (!id) return null;
      const existing = this.memoryById.get(id);
      return existing ? this.cloneRecord(existing) : null;
    }

    const row = await model
      .findOne({ keyHash: normalizedHash })
      .lean<McpApiKeyDocument>()
      .exec();
    return row ? this.toRecord(row) : null;
  }

  async revokeByIdForOwner(
    keyId: string,
    userId: string,
    organizationId: string,
    now: Date,
  ): Promise<McpApiKeyRecord | null> {
    const normalizedKeyId = keyId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const normalizedOrgId = organizationId.toLowerCase();
    const model = this.resolveModel();
    if (!model) {
      const existing = this.memoryById.get(normalizedKeyId);
      if (
        !existing ||
        existing.userId !== normalizedUserId ||
        existing.organizationId !== normalizedOrgId
      ) {
        return null;
      }
      if (!existing.revokedAt) {
        existing.revokedAt = new Date(now.getTime());
        existing.updatedAt = new Date(now.getTime());
      }
      return this.cloneRecord(existing);
    }

    if (
      !Types.ObjectId.isValid(normalizedKeyId) ||
      !Types.ObjectId.isValid(normalizedUserId) ||
      !Types.ObjectId.isValid(normalizedOrgId)
    ) {
      return null;
    }

    const filter = {
      _id: new Types.ObjectId(normalizedKeyId),
      userId: new Types.ObjectId(normalizedUserId),
      organizationId: new Types.ObjectId(normalizedOrgId),
    };

    const existing = await model
      .findOne(filter)
      .lean<McpApiKeyDocument>()
      .exec();
    if (!existing) {
      return null;
    }
    if (existing.revokedAt instanceof Date) {
      return this.toRecord(existing);
    }

    const updated = await model
      .findOneAndUpdate(
        { ...filter, revokedAt: null },
        { $set: { revokedAt: now } },
        { new: true },
      )
      .lean<McpApiKeyDocument>()
      .exec();

    if (updated) {
      return this.toRecord(updated);
    }
    const fallback = await model
      .findOne(filter)
      .lean<McpApiKeyDocument>()
      .exec();
    return fallback ? this.toRecord(fallback) : null;
  }

  async touchLastUsedAt(keyId: string, now: Date): Promise<void> {
    const normalizedKeyId = keyId.toLowerCase();
    const model = this.resolveModel();
    if (!model) {
      const existing = this.memoryById.get(normalizedKeyId);
      if (existing) {
        existing.lastUsedAt = new Date(now.getTime());
      }
      return;
    }

    if (!Types.ObjectId.isValid(normalizedKeyId)) {
      return;
    }

    await model
      .updateOne(
        { _id: new Types.ObjectId(normalizedKeyId) },
        { $set: { lastUsedAt: now } },
        { timestamps: false },
      )
      .exec();
  }
}
