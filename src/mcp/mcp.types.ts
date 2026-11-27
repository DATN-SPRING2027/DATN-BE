import type { AuthenticatedIdentity } from '../services/iam/application/authentication/authentication.application.service';
import type { McpKeyScopeMode } from '../services/iam/application/mcp-api-keys/mcp-api-key.types';

export const MCP_SERVER_NAME = 'continuum-mcp' as const;
export const MCP_SERVER_VERSION = '1.0.0' as const;
export const MCP_CANONICAL_PROTOCOL_VERSION = '2025-03-26' as const;

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export type McpProtocolVersion =
  (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];

export type JsonRpcId = string | number | null;

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> =
  JsonRpcSuccessResponse<TResult> | JsonRpcErrorResponse;

export class McpJsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = McpJsonRpcError.name;
  }
}

export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  requiredScope: McpKeyScopeMode;
}

export interface McpPublicToolView {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

export interface McpTextContentBlock {
  type: 'text';
  text: string;
}

export interface McpToolCallResult {
  content: McpTextContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceReadResult {
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
}

export interface McpPromptArgumentDefinition {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments: McpPromptArgumentDefinition[];
}

export interface McpPromptGetResult {
  description: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: McpTextContentBlock;
  }>;
}

export interface McpCallContext {
  actor: AuthenticatedIdentity;
  authorizationHeader?: string;
  cookieHeader?: string;
  requestId?: string;
}

export type McpDispatchOutcome =
  | {
      kind: 'accepted';
    }
  | {
      kind: 'response';
      protocolVersion: McpProtocolVersion;
      body: JsonRpcResponse | JsonRpcResponse[];
    };
