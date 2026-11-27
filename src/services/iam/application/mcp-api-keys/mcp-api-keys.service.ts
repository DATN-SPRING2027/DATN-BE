import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import { ProjectService } from '../projects/project.service';
import {
  MCP_API_KEY_REPOSITORY,
  type McpApiKeyRecord,
  type McpApiKeyRepositoryPort,
} from './mcp-api-key.repository';
import {
  MCP_CANONICAL_TOOL_COUNT,
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_ENDPOINT_PATH,
  MCP_KEY_SCOPES,
  type CreateMcpApiKeyResponse,
  type ListMcpApiKeysResponse,
  type McpApiKeyStatus,
  type McpApiKeyView,
  type McpKeyScopeMode,
  type RevokeMcpApiKeyResponse,
} from './mcp-api-key.types';

const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;
const MAX_ACTIVE_KEYS_PER_USER_ORG = 50;
const MAX_ALLOWED_PROJECTS = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deriveMcpApiKeyStatus(
  record: Pick<McpApiKeyRecord, 'revokedAt' | 'expiresAt'>,
  now: Date,
): McpApiKeyStatus {
  if (record.revokedAt) {
    return 'REVOKED';
  }
  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }
  return 'ACTIVE';
}

export function toMcpApiKeyView(
  record: McpApiKeyRecord,
  now: Date,
): McpApiKeyView {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    scope: record.scope,
    allowedProjectIds: record.allowedProjectIds
      ? [...record.allowedProjectIds]
      : null,
    organizationId: record.organizationId,
    userId: record.userId,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
    revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
    status: deriveMcpApiKeyStatus(record, now),
  };
}

@Injectable()
export class McpApiKeysService {
  constructor(
    @Inject(MCP_API_KEY_REPOSITORY)
    private readonly repository: McpApiKeyRepositoryPort,
    private readonly projectService: ProjectService,
  ) {}

  async list(actor: AuthenticatedIdentity): Promise<ListMcpApiKeysResponse> {
    const now = new Date();
    const records = await this.repository.listByUserAndOrganization(
      actor.id,
      actor.organizationId,
    );
    return {
      items: records.map((record) => toMcpApiKeyView(record, now)),
      mcpEndpointPath: MCP_ENDPOINT_PATH,
      protocolVersion: MCP_DEFAULT_PROTOCOL_VERSION,
      toolCount: MCP_CANONICAL_TOOL_COUNT,
    };
  }

  async create(
    actor: AuthenticatedIdentity,
    rawBody: unknown,
  ): Promise<CreateMcpApiKeyResponse> {
    if (!isPlainRecord(rawBody)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request body must be a JSON object.',
      });
    }

    const allowedFields = new Set([
      'name',
      'scope',
      'allowedProjectIds',
      'expiresInDays',
    ]);
    for (const key of Object.keys(rawBody)) {
      if (!allowedFields.has(key)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `Unsupported field '${key}'.`,
        });
      }
    }

    const name = typeof rawBody.name === 'string' ? rawBody.name.trim() : '';
    if (name.length < 1 || name.length > 80) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'name is required and must be between 1 and 80 characters.',
      });
    }

    let scope: McpKeyScopeMode = 'FULL_OPERATIONS';
    if (rawBody.scope !== undefined) {
      if (
        typeof rawBody.scope !== 'string' ||
        !MCP_KEY_SCOPES.includes(rawBody.scope as McpKeyScopeMode)
      ) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message:
            'scope must be one of READ_ONLY, READ_WRITE, FULL_OPERATIONS.',
        });
      }
      scope = rawBody.scope as McpKeyScopeMode;
    }

    const now = new Date();
    let expiresAt: Date | null = null;
    if (rawBody.expiresInDays !== undefined && rawBody.expiresInDays !== null) {
      if (
        typeof rawBody.expiresInDays !== 'number' ||
        !Number.isSafeInteger(rawBody.expiresInDays) ||
        rawBody.expiresInDays < 1 ||
        rawBody.expiresInDays > 365
      ) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message:
            'expiresInDays must be null or an integer between 1 and 365.',
        });
      }
      expiresAt = new Date(now.getTime() + rawBody.expiresInDays * MS_PER_DAY);
    }

    let allowedProjectIds: string[] | null = null;
    if (
      rawBody.allowedProjectIds !== undefined &&
      rawBody.allowedProjectIds !== null
    ) {
      if (
        !Array.isArray(rawBody.allowedProjectIds) ||
        rawBody.allowedProjectIds.length < 1 ||
        rawBody.allowedProjectIds.length > MAX_ALLOWED_PROJECTS
      ) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: `allowedProjectIds must be null or an array of 1 to ${MAX_ALLOWED_PROJECTS} project IDs.`,
        });
      }

      const normalizedIds: string[] = [];
      const seen = new Set<string>();
      for (const item of rawBody.allowedProjectIds) {
        if (typeof item !== 'string' || !OBJECT_ID_REGEX.test(item.trim())) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message:
              'Each entry in allowedProjectIds must be a valid 24-character hex project ID.',
          });
        }
        const cleanId = item.trim().toLowerCase();
        if (!seen.has(cleanId)) {
          seen.add(cleanId);
          normalizedIds.push(cleanId);
        }
      }

      for (const projectId of normalizedIds) {
        await this.projectService.get(actor, projectId);
      }
      allowedProjectIds = normalizedIds;
    }

    const existing = await this.repository.listByUserAndOrganization(
      actor.id,
      actor.organizationId,
    );
    const activeCount = existing.filter(
      (record) => deriveMcpApiKeyStatus(record, now) === 'ACTIVE',
    ).length;
    if (activeCount >= MAX_ACTIVE_KEYS_PER_USER_ORG) {
      throw new ConflictException({
        code: 'MCP_API_KEY_LIMIT_EXCEEDED',
        message: `You can have at most ${MAX_ACTIVE_KEYS_PER_USER_ORG} active MCP API keys per organization. Revoke unused keys first.`,
      });
    }

    const rawKey = `ctm_mcp_${randomBytes(32).toString('base64url')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 16);

    const created = await this.repository.create({
      organizationId: actor.organizationId,
      userId: actor.id,
      name,
      keyHash,
      keyPrefix,
      scope,
      allowedProjectIds,
      expiresAt,
      now,
    });

    return {
      key: toMcpApiKeyView(created, now),
      rawKey,
    };
  }

  async revoke(
    actor: AuthenticatedIdentity,
    keyId: string,
  ): Promise<RevokeMcpApiKeyResponse> {
    if (typeof keyId !== 'string' || !OBJECT_ID_REGEX.test(keyId.trim())) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Invalid MCP API key identifier.',
      });
    }
    const now = new Date();
    const revoked = await this.repository.revokeByIdForOwner(
      keyId.trim().toLowerCase(),
      actor.id,
      actor.organizationId,
      now,
    );
    if (!revoked) {
      throw new NotFoundException({
        code: 'MCP_API_KEY_NOT_FOUND',
        message: 'MCP API key not found.',
      });
    }
    return {
      key: toMcpApiKeyView(revoked, now),
    };
  }
}
