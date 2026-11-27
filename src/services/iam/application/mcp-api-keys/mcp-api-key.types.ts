export const MCP_ENDPOINT_PATH = '/api/v1/mcp' as const;
export const MCP_DEFAULT_PROTOCOL_VERSION = '2025-03-26' as const;
export const MCP_CANONICAL_TOOL_COUNT = 36 as const;

export const MCP_KEY_SCOPES = [
  'READ_ONLY',
  'READ_WRITE',
  'FULL_OPERATIONS',
] as const;

export type McpKeyScopeMode = (typeof MCP_KEY_SCOPES)[number];

export type McpApiKeyStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface McpApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  scope: McpKeyScopeMode;
  allowedProjectIds: string[] | null;
  organizationId: string;
  userId: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: McpApiKeyStatus;
}

export interface ListMcpApiKeysResponse {
  items: McpApiKeyView[];
  mcpEndpointPath: '/api/v1/mcp';
  protocolVersion: '2025-03-26';
  toolCount: 36;
}

export interface CreateMcpApiKeyRequest {
  name: string;
  scope?: McpKeyScopeMode;
  allowedProjectIds?: string[] | null;
  expiresInDays?: number | null;
}

export interface CreateMcpApiKeyResponse {
  key: McpApiKeyView;
  rawKey: string;
}

export interface RevokeMcpApiKeyResponse {
  key: McpApiKeyView;
}
