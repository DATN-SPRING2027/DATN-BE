import type { McpKeyScopeMode } from './mcp-api-key.types';

export const MCP_API_KEY_REPOSITORY = Symbol('MCP_API_KEY_REPOSITORY');

export interface McpApiKeyRecord {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scope: McpKeyScopeMode;
  allowedProjectIds: string[] | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMcpApiKeyRecordInput {
  organizationId: string;
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scope: McpKeyScopeMode;
  allowedProjectIds: string[] | null;
  expiresAt: Date | null;
  now: Date;
}

export interface McpApiKeyRepositoryPort {
  create(input: CreateMcpApiKeyRecordInput): Promise<McpApiKeyRecord>;
  listByUserAndOrganization(
    userId: string,
    organizationId: string,
  ): Promise<McpApiKeyRecord[]>;
  findByKeyHash(keyHash: string): Promise<McpApiKeyRecord | null>;
  revokeByIdForOwner(
    keyId: string,
    userId: string,
    organizationId: string,
    now: Date,
  ): Promise<McpApiKeyRecord | null>;
  touchLastUsedAt(keyId: string, now: Date): Promise<void>;
}
