import { Injectable } from '@nestjs/common';
import { McpToolsService } from './mcp-tools.service';
import {
  JSON_RPC_ERROR_CODES,
  MCP_CANONICAL_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  McpJsonRpcError,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcResponse,
  type McpCallContext,
  type McpDispatchOutcome,
  type McpProtocolVersion,
} from './mcp.types';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidRequestId(value: unknown): value is string | number {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
}

function negotiateProtocolVersion(requested: unknown): McpProtocolVersion {
  if (
    typeof requested === 'string' &&
    (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested as McpProtocolVersion;
  }
  return MCP_CANONICAL_PROTOCOL_VERSION;
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

@Injectable()
export class McpService {
  constructor(private readonly toolsService: McpToolsService) {}

  async handlePayload(
    ctx: McpCallContext,
    payload: unknown,
    headerProtocolVersion?: string,
  ): Promise<McpDispatchOutcome> {
    const defaultProtocol = negotiateProtocolVersion(headerProtocolVersion);

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return {
          kind: 'response',
          protocolVersion: defaultProtocol,
          body: errorResponse(
            null,
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            'JSON-RPC batch array must not be empty.',
          ),
        };
      }
      if (payload.length > 50) {
        return {
          kind: 'response',
          protocolVersion: defaultProtocol,
          body: errorResponse(
            null,
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            'JSON-RPC batch array exceeds maximum size of 50 messages.',
          ),
        };
      }

      const responses: JsonRpcResponse[] = [];
      let negotiatedVersion = defaultProtocol;

      for (const item of payload) {
        const single = await this.handleSingleMessage(
          ctx,
          item,
          negotiatedVersion,
        );
        if (single.kind === 'response') {
          negotiatedVersion = single.protocolVersion;
          responses.push(single.body);
        }
      }

      if (responses.length === 0) {
        return { kind: 'accepted' };
      }
      return {
        kind: 'response',
        protocolVersion: negotiatedVersion,
        body: responses,
      };
    }

    const single = await this.handleSingleMessage(
      ctx,
      payload,
      defaultProtocol,
    );
    if (single.kind === 'accepted') {
      return { kind: 'accepted' };
    }
    return {
      kind: 'response',
      protocolVersion: single.protocolVersion,
      body: single.body,
    };
  }

  private async handleSingleMessage(
    ctx: McpCallContext,
    rawMessage: unknown,
    activeProtocol: McpProtocolVersion,
  ): Promise<
    | { kind: 'accepted' }
    | {
        kind: 'response';
        protocolVersion: McpProtocolVersion;
        body: JsonRpcResponse;
      }
  > {
    if (!isPlainRecord(rawMessage)) {
      return {
        kind: 'response',
        protocolVersion: activeProtocol,
        body: errorResponse(
          null,
          JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          'JSON-RPC message must be a JSON object.',
        ),
      };
    }

    const hasId = Object.prototype.hasOwnProperty.call(rawMessage, 'id');
    const rawId = rawMessage.id;
    const responseId: JsonRpcId =
      hasId && isValidRequestId(rawId) ? rawId : null;

    if (
      rawMessage.jsonrpc !== '2.0' ||
      typeof rawMessage.method !== 'string' ||
      rawMessage.method.trim().length === 0 ||
      (hasId && !isValidRequestId(rawId)) ||
      (rawMessage.params !== undefined &&
        !isPlainRecord(rawMessage.params) &&
        !Array.isArray(rawMessage.params))
    ) {
      return {
        kind: 'response',
        protocolVersion: activeProtocol,
        body: errorResponse(
          responseId,
          JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          'Invalid JSON-RPC 2.0 request envelope.',
        ),
      };
    }

    const method = rawMessage.method.trim();
    const params = isPlainRecord(rawMessage.params) ? rawMessage.params : {};

    if (method.startsWith('notifications/') && hasId) {
      return {
        kind: 'response',
        protocolVersion: activeProtocol,
        body: errorResponse(
          responseId,
          JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          'Notifications must not include an id.',
        ),
      };
    }

    // Notifications (no `id` field)
    if (!hasId) {
      return { kind: 'accepted' };
    }

    try {
      switch (method) {
        case 'initialize': {
          const negotiated = negotiateProtocolVersion(params.protocolVersion);
          return {
            kind: 'response',
            protocolVersion: negotiated,
            body: {
              jsonrpc: '2.0',
              id: responseId,
              result: {
                protocolVersion: negotiated,
                capabilities: {
                  tools: { listChanged: false },
                  resources: { subscribe: false, listChanged: false },
                  prompts: { listChanged: false },
                },
                serverInfo: {
                  name: MCP_SERVER_NAME,
                  version: MCP_SERVER_VERSION,
                },
                instructions:
                  'Continuum AI MCP Server. Use continuum_get_context or continuum_list_projects to discover accessible projects, then query SAG knowledge, tasks, work notes, documents, handovers, chat, and notifications within your granted scope.',
              },
            },
          };
        }

        case 'notifications/initialized':
        case 'notifications/cancelled': {
          return { kind: 'accepted' };
        }

        case 'ping': {
          return {
            kind: 'response',
            protocolVersion: activeProtocol,
            body: {
              jsonrpc: '2.0',
              id: responseId,
              result: {},
            },
          };
        }

        case 'tools/list': {
          return {
            kind: 'response',
            protocolVersion: activeProtocol,
            body: {
              jsonrpc: '2.0',
              id: responseId,
              result: {
                tools: this.toolsService.listToolsForActor(ctx.actor),
              },
            },
          };
        }

        case 'tools/call': {
          if (typeof params.name !== 'string' || !params.name.trim()) {
            throw new McpJsonRpcError(
              JSON_RPC_ERROR_CODES.INVALID_PARAMS,
              'tools/call requires a non-empty string "name" parameter.',
            );
          }
          const result = await this.toolsService.callTool(
            ctx,
            params.name.trim(),
            params.arguments,
          );
          return {
            kind: 'response',
            protocolVersion: activeProtocol,
            body: {
              jsonrpc: '2.0',
              id: responseId,
              result,
            },
          };
        }

        case 'resources/list': {
          return {
            kind: 'response',
            protocolVersion: activeProtocol,
            body: {
              jsonrpc: '2.0',
              id: responseId,
              result: {
                resources: this.toolsService.listResources(),
              },
            },
          };
        }

        case 'resources/templates/list': {
          return {
            kind: 'response',
            protocolVersion: activeProtocol,
            body: {
              jsonrpc: '2.0',
              id: responseId,
              result: {
                resourceTemplates: this.toolsService.listResourceTemplates(),
              },
            },
          };
        }

        case 'resources/read': {
          if (typeof params.uri !== 'string' || !params.uri.trim()) {
            throw new McpJsonRpcError(
              JSON_RPC_ERROR_CODES.INVALID_PARAMS,
              'resources/read requires a non-empty string "uri" parameter.',
            );
          }
          const result = await this.toolsService.readResource(
            ctx,
            params.uri.trim(),
          );
          return {
            kind: 'response',
            protocolVersion: activeProtocol,
            body: {
              jsonrpc: '2.0',
              id: responseId,
              result,
            },
          };
        }

        case 'prompts/list': {
          return {
            kind: 'response',
            protocolVersion: activeProtocol,
            body: {
              jsonrpc: '2.0',
              id: responseId,
              result: {
                prompts: this.toolsService.listPrompts(),
              },
            },
          };
        }

        case 'prompts/get': {
          if (typeof params.name !== 'string' || !params.name.trim()) {
            throw new McpJsonRpcError(
              JSON_RPC_ERROR_CODES.INVALID_PARAMS,
              'prompts/get requires a non-empty string "name" parameter.',
            );
          }
          const promptArgs = isPlainRecord(params.arguments)
            ? params.arguments
            : undefined;
          const result = this.toolsService.getPrompt(
            ctx,
            params.name.trim(),
            promptArgs,
          );
          return {
            kind: 'response',
            protocolVersion: activeProtocol,
            body: {
              jsonrpc: '2.0',
              id: responseId,
              result,
            },
          };
        }

        default:
          return {
            kind: 'response',
            protocolVersion: activeProtocol,
            body: errorResponse(
              responseId,
              JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
              `Method not found: ${method}`,
            ),
          };
      }
    } catch (error) {
      if (error instanceof McpJsonRpcError) {
        return {
          kind: 'response',
          protocolVersion: activeProtocol,
          body: errorResponse(
            responseId,
            error.code,
            error.message,
            error.data,
          ),
        };
      }
      return {
        kind: 'response',
        protocolVersion: activeProtocol,
        body: errorResponse(
          responseId,
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          'Internal MCP server error.',
        ),
      };
    }
  }
}
