import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AiChatService } from '../integrations/ai-engine/ai-chat.service';
import type { AiChatRequestHeaders } from '../integrations/ai-engine/ai-chat.types';
import { WorkNotesService } from '../services/capture/application/work-notes.service';
import type {
  CaptureRequestHeaders,
  DocumentStatus,
  DocumentType,
  TaskNoteReviewStatus,
  WorkReportScope,
  WorkReportStatus,
} from '../services/capture/application/work-notes.types';
import { ChatFeaturesService } from '../services/chat/application/chat-features.service';
import { ChatApplicationService } from '../services/chat/application/chat.service';
import { HandoverWorkflowService } from '../services/handover/application/handover-workflow.service';
import type { HandoverRequestHeaders } from '../services/handover/application/handover.types';
import {
  readCookie,
  type AuthenticatedIdentity,
} from '../services/iam/application/authentication/authentication.application.service';
import type { McpKeyScopeMode } from '../services/iam/application/mcp-api-keys/mcp-api-key.types';
import { ProjectAccessService } from '../services/iam/application/projects/project-access.service';
import { ProjectService } from '../services/iam/application/projects/project.service';
import { NotificationService } from '../services/notification/notification.service';
import { TaskWorkspaceService } from '../services/task/workspace/task-workspace.service';
import {
  MCP_PROMPTS_CATALOG,
  MCP_RESOURCES_CATALOG,
  MCP_RESOURCE_TEMPLATES_CATALOG,
  MCP_TOOLS_CATALOG,
} from './mcp-tools.catalog';
import { validateMcpToolArguments } from './mcp-schema-validator';
import {
  JSON_RPC_ERROR_CODES,
  MCP_CANONICAL_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  McpJsonRpcError,
  type McpCallContext,
  type McpPromptDefinition,
  type McpPromptGetResult,
  type McpPublicToolView,
  type McpResourceDefinition,
  type McpResourceReadResult,
  type McpResourceTemplateDefinition,
  type McpToolCallResult,
} from './mcp.types';

const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;
const UNQUOTED_ETAG_REGEX = /^(task|handover):[a-fA-F0-9]{24}:\d+$/;

class McpScopeForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = McpScopeForbiddenError.name;
  }
}

export function deriveDeterministicUuidV4(
  rawKey: string,
  stepSuffix = 'default',
): string {
  const digest = createHash('sha256')
    .update(
      `continuum-mcp-idem:${stepSuffix}:${rawKey.normalize('NFC').trim()}`,
    )
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function normalizeIfMatch(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.normalize('NFC').trim();
  if (!trimmed) return undefined;
  if (UNQUOTED_ETAG_REGEX.test(trimmed)) {
    return `"${trimmed}"`;
  }
  return trimmed;
}

function asOptionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.normalize('NFC').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const SCOPE_TIER_RANK: Readonly<Record<McpKeyScopeMode, number>> = {
  READ_ONLY: 1,
  READ_WRITE: 2,
  FULL_OPERATIONS: 3,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertObjectId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !OBJECT_ID_REGEX.test(value.trim())) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${fieldName} must be a valid 24-character hex identifier.`,
    });
  }
  return value.trim().toLowerCase();
}

function optionalObjectId(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertObjectId(value, fieldName);
}

function positiveInt(
  value: unknown,
  fallback: number,
  max: number,
  fieldName: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${fieldName} must be an integer between 1 and ${max}.`,
    });
  }
  return value;
}

@Injectable()
export class McpToolsService {
  private readonly logger = new Logger(McpToolsService.name);
  private readonly toolMap = new Map(
    MCP_TOOLS_CATALOG.map((tool) => [tool.name, tool]),
  );

  constructor(
    private readonly projectService: ProjectService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly taskWorkspaceService: TaskWorkspaceService,
    private readonly workNotesService: WorkNotesService,
    private readonly handoverWorkflowService: HandoverWorkflowService,
    private readonly aiChatService: AiChatService,
    private readonly chatService: ChatApplicationService,
    private readonly chatFeaturesService: ChatFeaturesService,
    private readonly notificationService: NotificationService,
  ) {}

  private effectiveScope(actor: AuthenticatedIdentity): McpKeyScopeMode {
    return actor.mcpGrant?.scope ?? 'FULL_OPERATIONS';
  }

  private hasScope(
    actor: AuthenticatedIdentity,
    required: McpKeyScopeMode,
  ): boolean {
    return (
      SCOPE_TIER_RANK[this.effectiveScope(actor)] >= SCOPE_TIER_RANK[required]
    );
  }

  private isProjectAllowed(
    actor: AuthenticatedIdentity,
    projectId: string,
  ): boolean {
    const allowed = actor.mcpGrant?.allowedProjectIds;
    if (!Array.isArray(allowed)) return true;
    const normalized = projectId.trim().toLowerCase();
    return allowed.some((id) => id.toLowerCase() === normalized);
  }

  private scopeForbiddenResult(message: string): McpToolCallResult {
    const payload = {
      code: 'MCP_SCOPE_FORBIDDEN',
      message,
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }

  private successResult(data: unknown): McpToolCallResult {
    const structured = isPlainRecord(data) ? data : { result: data ?? null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
      structuredContent: structured,
    };
  }

  private errorResultFromException(error: unknown): McpToolCallResult {
    if (error instanceof McpScopeForbiddenError) {
      return this.scopeForbiddenResult(error.message);
    }
    if (error instanceof HttpException) {
      const response = error.getResponse();
      const status = error.getStatus();
      const payload: Record<string, unknown> = isPlainRecord(response)
        ? { status, ...response }
        : {
            status,
            code: 'HTTP_ERROR',
            message: typeof response === 'string' ? response : error.message,
          };
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }

    const fallback = {
      code: 'INTERNAL_TOOL_ERROR',
      message:
        error instanceof Error
          ? error.message
          : 'Unexpected tool execution failure.',
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(fallback, null, 2) }],
      structuredContent: fallback,
    };
  }

  private buildSyntheticMutationAuth(ctx: McpCallContext): {
    authorizationHeader?: string;
    cookieHeader: string;
    csrfHeader: string;
  } {
    const csrf = randomBytes(16).toString('hex');
    if (ctx.authorizationHeader) {
      return {
        authorizationHeader: ctx.authorizationHeader,
        cookieHeader: `__Host-csrf=${csrf}`,
        csrfHeader: csrf,
      };
    }
    const accessCookie = readCookie(ctx.cookieHeader, 'continuum_access');
    return {
      cookieHeader: accessCookie
        ? `continuum_access=${encodeURIComponent(accessCookie)}; __Host-csrf=${csrf}`
        : `__Host-csrf=${csrf}`,
      csrfHeader: csrf,
    };
  }

  private buildCaptureHeaders(ctx: McpCallContext): CaptureRequestHeaders {
    const synth = this.buildSyntheticMutationAuth(ctx);
    return {
      authorization: synth.authorizationHeader,
      cookie: synth.cookieHeader,
      csrfToken: synth.csrfHeader,
      organizationId: ctx.actor.organizationId,
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    };
  }

  private buildAiHeaders(ctx: McpCallContext): AiChatRequestHeaders {
    return {
      authorization: ctx.authorizationHeader,
      cookie: ctx.cookieHeader,
      organizationId: ctx.actor.organizationId,
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    };
  }

  private buildHandoverReadHeaders(
    ctx: McpCallContext,
  ): HandoverRequestHeaders {
    return {
      authorization: ctx.authorizationHeader,
      cookie: ctx.cookieHeader,
      organizationId: ctx.actor.organizationId,
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    };
  }

  private buildHandoverMutationHeaders(
    ctx: McpCallContext,
    options?: {
      ifMatch?: string;
      idempotencyKey?: string;
      stepSuffix?: string;
    },
  ): HandoverRequestHeaders {
    const synth = this.buildSyntheticMutationAuth(ctx);
    const rawIdemKey = asOptionalString(options?.idempotencyKey);
    const idempotencyKey = rawIdemKey
      ? deriveDeterministicUuidV4(rawIdemKey, options?.stepSuffix ?? 'default')
      : randomUUID();
    const normalizedIfMatch = normalizeIfMatch(options?.ifMatch);
    return {
      authorization: synth.authorizationHeader,
      cookie: synth.cookieHeader,
      csrfToken: synth.csrfHeader,
      organizationId: ctx.actor.organizationId,
      idempotencyKey,
      ...(normalizedIfMatch ? { ifMatch: normalizedIfMatch } : {}),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    };
  }

  listToolsForActor(actor: AuthenticatedIdentity): McpPublicToolView[] {
    const isProjectRestricted = Array.isArray(
      actor.mcpGrant?.allowedProjectIds,
    );
    return MCP_TOOLS_CATALOG.filter((tool) => {
      if (isProjectRestricted && tool.name === 'continuum_chat') {
        return false;
      }
      return this.hasScope(actor, tool.requiredScope);
    }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }));
  }

  listResources(): readonly McpResourceDefinition[] {
    return MCP_RESOURCES_CATALOG;
  }

  listResourceTemplates(): readonly McpResourceTemplateDefinition[] {
    return MCP_RESOURCE_TEMPLATES_CATALOG;
  }

  async readResource(
    ctx: McpCallContext,
    uri: string,
  ): Promise<McpResourceReadResult> {
    if (uri === 'continuum://context/current') {
      const activeProjects = await this.projectService.list(ctx.actor, {
        page: 1,
        pageSize: 50,
        status: 'ACTIVE',
      });
      const payload = {
        actor: {
          id: ctx.actor.id,
          email: ctx.actor.email,
          name: ctx.actor.name,
          organizationId: ctx.actor.organizationId,
          roles: ctx.actor.roles,
        },
        mcpGrant: ctx.actor.mcpGrant ?? null,
        activeProjects: activeProjects.data,
      };
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }

    const overviewMatch =
      /^continuum:\/\/projects\/([a-fA-F0-9]{24})\/overview$/.exec(uri);
    if (overviewMatch) {
      const projectId = overviewMatch[1].toLowerCase();
      if (!this.isProjectAllowed(ctx.actor, projectId)) {
        throw new McpJsonRpcError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          `MCP API key is not authorized for project ${projectId}.`,
          { code: 'MCP_SCOPE_FORBIDDEN' },
        );
      }
      const project = await this.projectService.get(ctx.actor, projectId);
      const [leaders, taskSummaryOutcome, sprintsOutcome] = await Promise.all([
        this.projectAccessService.listLeaders(ctx.actor, projectId),
        this.taskWorkspaceService
          .getProjectTaskSummary({
            authorizationHeader: ctx.authorizationHeader,
            cookieHeader: ctx.cookieHeader,
            headerOrgId: ctx.actor.organizationId,
            projectId,
          })
          .then((res) => ({ ok: true as const, body: res.body }))
          .catch((error: unknown) => {
            if (
              error instanceof UnauthorizedException ||
              error instanceof ForbiddenException ||
              error instanceof NotFoundException
            ) {
              throw error;
            }
            const errDetail =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
            this.logger.warn(
              `Degraded overview resource for project ${projectId}: getProjectTaskSummary failed (${errDetail})`,
            );
            return { ok: false as const, body: null };
          }),
        this.taskWorkspaceService
          .listProjectSprints({
            authorizationHeader: ctx.authorizationHeader,
            cookieHeader: ctx.cookieHeader,
            headerOrgId: ctx.actor.organizationId,
            projectId,
            query: {},
          })
          .then((res) => ({ ok: true as const, body: res.body }))
          .catch((error: unknown) => {
            if (
              error instanceof UnauthorizedException ||
              error instanceof ForbiddenException ||
              error instanceof NotFoundException
            ) {
              throw error;
            }
            const errDetail =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
            this.logger.warn(
              `Degraded overview resource for project ${projectId}: listProjectSprints failed (${errDetail})`,
            );
            return { ok: false as const, body: null };
          }),
      ]);

      const degradedFields: string[] = [];
      if (!taskSummaryOutcome.ok) {
        degradedFields.push('taskSummary');
      }
      if (!sprintsOutcome.ok) {
        degradedFields.push('sprints');
      }

      const payload = {
        project,
        leaders: leaders.data,
        taskSummary: taskSummaryOutcome.body,
        sprints: sprintsOutcome.body,
        degraded: degradedFields.length > 0,
        ...(degradedFields.length > 0 ? { degradedFields } : {}),
      };
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }

    throw new McpJsonRpcError(
      JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      `Resource not found: ${uri}`,
    );
  }

  listPrompts(): readonly McpPromptDefinition[] {
    return MCP_PROMPTS_CATALOG;
  }

  getPrompt(
    ctx: McpCallContext,
    name: string,
    rawArgs?: Record<string, unknown>,
  ): McpPromptGetResult {
    const prompt = MCP_PROMPTS_CATALOG.find((item) => item.name === name);
    if (!prompt) {
      throw new McpJsonRpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Unknown prompt: ${name}`,
      );
    }

    const args = isPlainRecord(rawArgs) ? rawArgs : {};
    const projectId =
      typeof args.projectId === 'string' &&
      OBJECT_ID_REGEX.test(args.projectId.trim())
        ? args.projectId.trim().toLowerCase()
        : null;
    if (!projectId) {
      throw new McpJsonRpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        'projectId is required and must be a 24-character hex ID.',
      );
    }
    if (!this.isProjectAllowed(ctx.actor, projectId)) {
      throw new McpJsonRpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `MCP API key is not authorized for project ${projectId}.`,
        { code: 'MCP_SCOPE_FORBIDDEN' },
      );
    }

    if (name === 'daily-standup-brief') {
      return {
        description: prompt.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Prepare a Daily Standup Brief for Continuum project "${projectId}".`,
                `1. Call continuum_get_project_task_summary and continuum_list_tasks (status="IN_PROGRESS,BLOCKED,IN_REVIEW") for projectId="${projectId}".`,
                `2. Call continuum_list_work_notes (sort="recent", pageSize=10) for projectId="${projectId}".`,
                `3. Summarize Completed/Recent Progress, Active In-Flight Work, and Blockers with task keys and assignees.`,
              ].join('\n'),
            },
          },
        ],
      };
    }

    if (name === 'handover-readiness-audit') {
      const departingUserId =
        typeof args.departingUserId === 'string' &&
        OBJECT_ID_REGEX.test(args.departingUserId.trim())
          ? args.departingUserId.trim().toLowerCase()
          : undefined;
      return {
        description: prompt.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Run a Knowledge Handover Readiness Audit for project "${projectId}".`,
                departingUserId
                  ? `1. Call continuum_preview_departing_handover with projectId="${projectId}" and departingUserId="${departingUserId}".`
                  : `1. Call continuum_list_handovers for projectId="${projectId}" and inspect open packages via continuum_get_handover.`,
                `2. Cross-check unfinished tasks and unapproved work notes or documents via continuum_list_work_notes and continuum_list_documents.`,
                `3. Highlight missing knowledge coverage, pending successor acceptances, and concrete actions needed before handover completion.`,
              ].join('\n'),
            },
          },
        ],
      };
    }

    if (name === 'task-triage-assistant') {
      return {
        description: prompt.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Triage open tasks for Continuum project "${projectId}".`,
                `1. Call continuum_get_project_task_summary, continuum_list_sprints (status="ACTIVE"), and continuum_list_project_members for projectId="${projectId}".`,
                `2. Call continuum_list_tasks (status="TODO,BLOCKED,IN_PROGRESS", limit=50) for projectId="${projectId}".`,
                `3. Identify unassigned high-priority items, blocked tasks, and overdue tasks, then propose concrete assignments or status updates.`,
              ].join('\n'),
            },
          },
        ],
      };
    }

    return {
      description: prompt.description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Build a comprehensive Project Onboarding Pack for Continuum project "${projectId}".`,
              `1. Call continuum_get_project, continuum_list_project_members, and continuum_list_sprints for projectId="${projectId}".`,
              `2. Call continuum_list_documents (status="APPROVED") and continuum_search_knowledge (query="architecture overview setup conventions") for projectId="${projectId}".`,
              `3. Synthesize a structured onboarding guide covering project mission, architecture, key contacts/leaders, active sprint goals, and cited reference documents.`,
            ].join('\n'),
          },
        },
      ],
    };
  }

  private requiredScopeForInvocation(
    toolName: string,
    args: Record<string, unknown>,
  ): McpKeyScopeMode {
    const definition = this.toolMap.get(toolName);
    if (!definition) return 'FULL_OPERATIONS';

    if (
      toolName === 'continuum_save_work_report_draft' &&
      args.submit === true
    ) {
      return 'FULL_OPERATIONS';
    }
    if (toolName === 'continuum_chat' && args.action === 'SEND_MESSAGE') {
      return 'FULL_OPERATIONS';
    }
    if (
      toolName === 'continuum_notifications' &&
      (args.action === 'MARK_READ' || args.action === 'MARK_ALL_READ')
    ) {
      return 'READ_WRITE';
    }
    if (
      toolName === 'continuum_ask_knowledge' &&
      args.persistThread === true &&
      args.threadId === undefined
    ) {
      return 'READ_WRITE';
    }
    return definition.requiredScope;
  }

  async callTool(
    ctx: McpCallContext,
    toolName: string,
    rawArgs: unknown,
  ): Promise<McpToolCallResult> {
    const definition = this.toolMap.get(toolName);
    if (!definition) {
      throw new McpJsonRpcError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Unknown tool: ${toolName}`,
      );
    }

    try {
      const validation = validateMcpToolArguments(
        toolName,
        definition.inputSchema,
        rawArgs,
      );
      if (!validation.ok) {
        const payload: Record<string, unknown> = { ...validation.error };
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      }
      const args = validation.args;

      if (
        toolName === 'continuum_chat' &&
        Array.isArray(ctx.actor.mcpGrant?.allowedProjectIds)
      ) {
        return this.scopeForbiddenResult(
          'continuum_chat is organization-wide and requires an organization-wide MCP key.',
        );
      }

      const requiredScope = this.requiredScopeForInvocation(toolName, args);
      if (!this.hasScope(ctx.actor, requiredScope)) {
        return this.scopeForbiddenResult(
          `Tool '${toolName}' requires '${requiredScope}' scope, but current MCP key has '${this.effectiveScope(ctx.actor)}'.`,
        );
      }

      if (
        typeof args.projectId === 'string' &&
        args.projectId.trim().length > 0
      ) {
        if (!this.isProjectAllowed(ctx.actor, args.projectId)) {
          return this.scopeForbiddenResult(
            `MCP API key is not authorized to access project '${args.projectId.trim()}'.`,
          );
        }
      }

      const output = await this.executeTool(ctx, toolName, args);
      return this.successResult(output);
    } catch (error) {
      return this.errorResultFromException(error);
    }
  }

  private async executeTool(
    ctx: McpCallContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (toolName) {
      // ---------------------------------------------------------------------
      // 1. IAM & Projects
      // ---------------------------------------------------------------------
      case 'continuum_get_context': {
        return {
          actor: {
            id: ctx.actor.id,
            email: ctx.actor.email,
            name: ctx.actor.name,
            organizationId: ctx.actor.organizationId,
            roles: ctx.actor.roles,
          },
          mcpGrant: ctx.actor.mcpGrant ?? null,
          server: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
            protocolVersion: MCP_CANONICAL_PROTOCOL_VERSION,
          },
        };
      }

      case 'continuum_list_projects': {
        const page = positiveInt(args.page, 1, 1000, 'page');
        const pageSize = positiveInt(args.pageSize, 20, 100, 'pageSize');
        const status =
          args.status === 'ACTIVE' || args.status === 'ARCHIVED'
            ? args.status
            : undefined;
        if (args.status !== undefined && !status) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'status must be ACTIVE or ARCHIVED.',
          });
        }
        const q =
          typeof args.q === 'string' &&
          args.q.normalize('NFC').trim().length > 0
            ? args.q.normalize('NFC').trim().slice(0, 120)
            : undefined;
        return this.projectService.list(ctx.actor, {
          page,
          pageSize,
          ...(status ? { status } : {}),
          ...(q ? { q } : {}),
        });
      }

      case 'continuum_get_project': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        return this.projectService.get(ctx.actor, projectId);
      }

      case 'continuum_list_project_members': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        // Always verify caller has visibility/access on the project first!
        await this.projectService.get(ctx.actor, projectId);
        const page = positiveInt(args.page, 1, 1000, 'page');
        const pageSize = positiveInt(args.pageSize, 50, 100, 'pageSize');
        const status =
          args.status === undefined
            ? 'ACTIVE'
            : args.status === 'ACTIVE' || args.status === 'INACTIVE'
              ? args.status
              : undefined;
        if (!status) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'status must be ACTIVE or INACTIVE.',
          });
        }
        const search =
          typeof args.search === 'string' &&
          args.search.normalize('NFC').trim().length > 0
            ? args.search.normalize('NFC').trim().slice(0, 120)
            : undefined;
        const [members, leaders] = await Promise.all([
          this.projectAccessService.listMembers(ctx.actor, projectId, {
            page,
            pageSize,
            status,
            ...(search ? { search } : {}),
          }),
          this.projectAccessService.listLeaders(ctx.actor, projectId),
        ]);
        return {
          projectId,
          leaders: leaders.data,
          members: members.data,
          pagination: members.pagination,
        };
      }

      // ---------------------------------------------------------------------
      // 2. Tasks & Sprints
      // ---------------------------------------------------------------------
      case 'continuum_list_tasks': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const query: Record<string, unknown> = {};
        for (const key of [
          'limit',
          'afterId',
          'cursor',
          'status',
          'priority',
          'type',
          'assigneeId',
          'parentId',
          'sprintId',
          'dueFrom',
          'dueTo',
          'q',
        ]) {
          if (args[key] !== undefined) {
            query[key] = args[key];
          }
        }
        if (typeof query.assigneeId === 'string') {
          const trimmedAssignee = query.assigneeId.trim();
          query.assigneeId =
            trimmedAssignee === 'unassigned' ? 'none' : trimmedAssignee;
        }
        if (typeof query.sprintId === 'string') {
          const trimmedSprint = query.sprintId.trim();
          query.sprintId = trimmedSprint === 'backlog' ? 'none' : trimmedSprint;
        }
        if (typeof query.q === 'string') {
          query.q = query.q.normalize('NFC').trim();
        }
        const res = await this.taskWorkspaceService.listProjectTasks({
          authorizationHeader: ctx.authorizationHeader,
          cookieHeader: ctx.cookieHeader,
          headerOrgId: ctx.actor.organizationId,
          projectId,
          query,
        });
        return res.body;
      }

      case 'continuum_get_task': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const taskId = assertObjectId(args.taskId, 'taskId');
        const taskRes = await this.taskWorkspaceService.getProjectTask({
          authorizationHeader: ctx.authorizationHeader,
          cookieHeader: ctx.cookieHeader,
          headerOrgId: ctx.actor.organizationId,
          projectId,
          taskId,
        });
        const includeComments = args.includeComments === true;
        const includeHistory = args.includeHistory === true;
        const [commentsRes, historyRes] = await Promise.all([
          includeComments
            ? this.taskWorkspaceService.listTaskComments({
                authorizationHeader: ctx.authorizationHeader,
                cookieHeader: ctx.cookieHeader,
                headerOrgId: ctx.actor.organizationId,
                projectId,
                taskId,
                query: { limit: 50 },
              })
            : Promise.resolve(null),
          includeHistory
            ? this.taskWorkspaceService.listTaskHistory({
                authorizationHeader: ctx.authorizationHeader,
                cookieHeader: ctx.cookieHeader,
                headerOrgId: ctx.actor.organizationId,
                projectId,
                taskId,
                query: { page: 1, limit: 20 },
              })
            : Promise.resolve(null),
        ]);
        return {
          ...(isPlainRecord(taskRes.body)
            ? taskRes.body
            : { task: taskRes.body }),
          ...(taskRes.etag ? { etag: taskRes.etag } : {}),
          ...(commentsRes ? { comments: commentsRes.body } : {}),
          ...(historyRes ? { history: historyRes.body } : {}),
        };
      }

      case 'continuum_get_project_task_summary': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const res = await this.taskWorkspaceService.getProjectTaskSummary({
          authorizationHeader: ctx.authorizationHeader,
          cookieHeader: ctx.cookieHeader,
          headerOrgId: ctx.actor.organizationId,
          projectId,
        });
        return res.body;
      }

      case 'continuum_list_sprints': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const query: Record<string, unknown> = {};
        if (args.status !== undefined) {
          query.status = args.status;
        }
        const res = await this.taskWorkspaceService.listProjectSprints({
          authorizationHeader: ctx.authorizationHeader,
          cookieHeader: ctx.cookieHeader,
          headerOrgId: ctx.actor.organizationId,
          projectId,
          query,
        });
        return res.body;
      }

      case 'continuum_create_task': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const synth = this.buildSyntheticMutationAuth(ctx);
        const body: Record<string, unknown> = {};
        for (const key of [
          'title',
          'description',
          'type',
          'priority',
          'assigneeId',
          'parentId',
          'sprintId',
          'dueDate',
          'startDate',
          'labels',
          'steps',
        ]) {
          if (args[key] !== undefined) {
            body[key] = args[key];
          }
        }
        const idempotencyKey =
          typeof args.idempotencyKey === 'string' && args.idempotencyKey.trim()
            ? args.idempotencyKey.trim()
            : randomUUID();
        const res = await this.taskWorkspaceService.createProjectTask({
          authorizationHeader: synth.authorizationHeader,
          cookieHeader: synth.cookieHeader,
          csrfHeader: synth.csrfHeader,
          idempotencyKeyHeader: idempotencyKey,
          headerOrgId: ctx.actor.organizationId,
          correlationId: ctx.requestId,
          projectId,
          body,
        });
        return {
          ...(isPlainRecord(res.body) ? res.body : { task: res.body }),
          ...(res.etag ? { etag: res.etag } : {}),
        };
      }

      case 'continuum_update_task': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const taskId = assertObjectId(args.taskId, 'taskId');
        const synth = this.buildSyntheticMutationAuth(ctx);
        let ifMatch = normalizeIfMatch(args.ifMatch);
        if (!ifMatch) {
          const current = await this.taskWorkspaceService.getProjectTask({
            authorizationHeader: ctx.authorizationHeader,
            cookieHeader: ctx.cookieHeader,
            headerOrgId: ctx.actor.organizationId,
            projectId,
            taskId,
          });
          ifMatch = current.etag;
        }
        const body: Record<string, unknown> = {};
        for (const key of [
          'title',
          'description',
          'type',
          'priority',
          'assigneeId',
          'parentId',
          'sprintId',
          'dueDate',
          'startDate',
          'labels',
          'steps',
        ]) {
          if (args[key] !== undefined) {
            body[key] = args[key];
          }
        }
        const res = await this.taskWorkspaceService.updateProjectTask({
          authorizationHeader: synth.authorizationHeader,
          cookieHeader: synth.cookieHeader,
          csrfHeader: synth.csrfHeader,
          ifMatchHeader: ifMatch,
          headerOrgId: ctx.actor.organizationId,
          correlationId: ctx.requestId,
          projectId,
          taskId,
          body,
        });
        return {
          ...(isPlainRecord(res.body) ? res.body : { task: res.body }),
          ...(res.etag ? { etag: res.etag } : {}),
        };
      }

      case 'continuum_transition_task': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const taskId = assertObjectId(args.taskId, 'taskId');
        const synth = this.buildSyntheticMutationAuth(ctx);
        let ifMatch = normalizeIfMatch(args.ifMatch);
        if (!ifMatch) {
          const current = await this.taskWorkspaceService.getProjectTask({
            authorizationHeader: ctx.authorizationHeader,
            cookieHeader: ctx.cookieHeader,
            headerOrgId: ctx.actor.organizationId,
            projectId,
            taskId,
          });
          ifMatch = current.etag;
        }
        const idempotencyKey =
          typeof args.idempotencyKey === 'string' && args.idempotencyKey.trim()
            ? args.idempotencyKey.trim()
            : randomUUID();
        const body: Record<string, unknown> = {
          toStatus: args.toStatus,
          ...(args.fromStatus !== undefined
            ? { fromStatus: args.fromStatus }
            : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        };
        const res = await this.taskWorkspaceService.transitionProjectTask({
          authorizationHeader: synth.authorizationHeader,
          cookieHeader: synth.cookieHeader,
          csrfHeader: synth.csrfHeader,
          ifMatchHeader: ifMatch,
          idempotencyKeyHeader: idempotencyKey,
          headerOrgId: ctx.actor.organizationId,
          correlationId: ctx.requestId,
          projectId,
          taskId,
          body,
        });
        return {
          ...(isPlainRecord(res.body) ? res.body : { task: res.body }),
          ...(res.etag ? { etag: res.etag } : {}),
        };
      }

      case 'continuum_add_task_comment': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const taskId = assertObjectId(args.taskId, 'taskId');
        const synth = this.buildSyntheticMutationAuth(ctx);
        const idempotencyKey =
          typeof args.idempotencyKey === 'string' && args.idempotencyKey.trim()
            ? args.idempotencyKey.trim()
            : randomUUID();
        const res = await this.taskWorkspaceService.createTaskComment({
          authorizationHeader: synth.authorizationHeader,
          cookieHeader: synth.cookieHeader,
          csrfHeader: synth.csrfHeader,
          idempotencyKeyHeader: idempotencyKey,
          headerOrgId: ctx.actor.organizationId,
          correlationId: ctx.requestId,
          projectId,
          taskId,
          body: { body: args.body },
        });
        return res.body;
      }

      // ---------------------------------------------------------------------
      // 3. Work Notes, Documents & Reports
      // ---------------------------------------------------------------------
      case 'continuum_list_work_notes': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const taskId = optionalObjectId(args.taskId, 'taskId');
        const authorId = optionalObjectId(args.authorId, 'authorId');
        const page = positiveInt(args.page, 1, 1000, 'page');
        const pageSize = positiveInt(args.pageSize, 20, 50, 'pageSize');
        const reviewStatus =
          typeof args.reviewStatus === 'string'
            ? (args.reviewStatus as TaskNoteReviewStatus)
            : undefined;
        const sort =
          args.sort === 'oldest' ? ('oldest' as const) : ('recent' as const);
        const search =
          typeof args.search === 'string' && args.search.trim().length > 0
            ? args.search.trim().slice(0, 200)
            : undefined;
        return this.workNotesService.listProjectTaskNotes(
          this.buildCaptureHeaders(ctx),
          projectId,
          page,
          pageSize,
          {
            ...(taskId ? { taskId } : {}),
            ...(authorId ? { authorId } : {}),
            ...(reviewStatus ? { reviewStatus } : {}),
            ...(search ? { search } : {}),
            sort,
          },
        );
      }

      case 'continuum_get_work_note': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const noteId = assertObjectId(args.noteId, 'noteId');
        const taskId = optionalObjectId(args.taskId, 'taskId');
        const headers = this.buildCaptureHeaders(ctx);
        if (taskId) {
          return this.workNotesService.getTaskNote(
            headers,
            projectId,
            taskId,
            noteId,
          );
        }
        return this.workNotesService.getProjectTaskNote(
          headers,
          projectId,
          noteId,
        );
      }

      case 'continuum_create_work_note': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const taskId = assertObjectId(args.taskId, 'taskId');
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        const accomplishments =
          typeof args.accomplishments === 'string'
            ? args.accomplishments.trim()
            : '';
        const approach =
          typeof args.approach === 'string' ? args.approach.trim() : '';
        const reason =
          typeof args.reason === 'string' ? args.reason.trim() : '';
        if (
          !title ||
          title.length > 200 ||
          !accomplishments ||
          !approach ||
          !reason
        ) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message:
              'title (<=200 chars), accomplishments, approach, and reason are required.',
          });
        }
        return this.workNotesService.createTaskNote(
          this.buildCaptureHeaders(ctx),
          projectId,
          taskId,
          {
            title,
            accomplishments,
            approach,
            reason,
            ...(typeof args.autoApprove === 'boolean'
              ? { autoApprove: args.autoApprove }
              : {}),
          },
        );
      }

      case 'continuum_list_documents': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const page = positiveInt(args.page, 1, 1000, 'page');
        const pageSize = positiveInt(args.pageSize, 20, 50, 'pageSize');
        const status =
          typeof args.status === 'string'
            ? (args.status as DocumentStatus)
            : undefined;
        return this.workNotesService.listDocuments(
          this.buildCaptureHeaders(ctx),
          projectId,
          page,
          pageSize,
          status,
        );
      }

      case 'continuum_create_document': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        const content = typeof args.content === 'string' ? args.content : '';
        const docTypes = new Set([
          'MVP',
          'DATABASE_DESIGN',
          'RSR',
          'ARCHITECTURE',
          'API_SPECIFICATION',
          'RESEARCH',
          'REQUIREMENT',
          'DESIGN',
          'TECHNICAL_SPECIFICATION',
          'OTHER',
        ]);
        if (
          !title ||
          title.length > 200 ||
          !content.trim() ||
          typeof args.type !== 'string' ||
          !docTypes.has(args.type)
        ) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'Valid title, type, and non-empty content are required.',
          });
        }
        const headers = this.buildCaptureHeaders(ctx);
        const created = await this.workNotesService.createDocument(
          headers,
          projectId,
          {
            title,
            type: args.type as DocumentType,
            content,
            ...(typeof args.description === 'string'
              ? { description: args.description.trim() }
              : {}),
          },
        );
        if (args.submitForReview === true) {
          return this.workNotesService.submitDocument(
            headers,
            projectId,
            created.id,
          );
        }
        return created;
      }

      case 'continuum_list_work_reports': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const page = positiveInt(args.page, 1, 1000, 'page');
        const pageSize = positiveInt(args.pageSize, 20, 50, 'pageSize');
        const status =
          typeof args.status === 'string'
            ? (args.status as WorkReportStatus)
            : undefined;
        const scope: WorkReportScope =
          args.scope === 'LEADER' ? 'LEADER' : 'MEMBER';
        return this.workNotesService.listWorkReports(
          this.buildCaptureHeaders(ctx),
          projectId,
          page,
          pageSize,
          status,
          scope,
        );
      }

      case 'continuum_save_work_report_draft': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const reportId = optionalObjectId(args.reportId, 'reportId');
        const scope: WorkReportScope =
          args.scope === 'LEADER' ? 'LEADER' : 'MEMBER';
        const accomplishments =
          typeof args.accomplishments === 'string'
            ? args.accomplishments.trim()
            : '';
        const approach =
          typeof args.approach === 'string' ? args.approach.trim() : '';
        const reason =
          typeof args.reason === 'string' ? args.reason.trim() : '';
        if (!accomplishments || !approach || !reason) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'accomplishments, approach, and reason are required.',
          });
        }
        const headers = this.buildCaptureHeaders(ctx);
        const input = {
          accomplishments,
          approach,
          reason,
          ...(typeof args.blockers === 'string'
            ? { blockers: args.blockers }
            : {}),
          ...(typeof args.nextSteps === 'string'
            ? { nextSteps: args.nextSteps }
            : {}),
          ...(Array.isArray(args.documentIds)
            ? {
                documentIds: args.documentIds.map((id, idx) =>
                  assertObjectId(id, `documentIds[${idx}]`),
                ),
              }
            : {}),
        };

        const saved = reportId
          ? await this.workNotesService.updateWorkReportDraft(
              headers,
              projectId,
              reportId,
              input,
            )
          : await this.workNotesService.saveCurrentWorkReportDraft(
              headers,
              projectId,
              input,
              scope,
            );

        if (args.submit === true) {
          return this.workNotesService.submitWorkReport(
            headers,
            projectId,
            saved.id,
          );
        }
        return saved;
      }

      // ---------------------------------------------------------------------
      // 4. Knowledge Handover
      // ---------------------------------------------------------------------
      case 'continuum_list_handovers': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const query: Record<string, unknown> = {};
        if (args.participantRole !== undefined) {
          query.participantRole = args.participantRole;
        }
        if (args.cursor !== undefined) {
          query.cursor = args.cursor;
        }
        if (args.limit !== undefined) {
          query.limit = args.limit;
        }
        const res = await this.handoverWorkflowService.listHandovers(
          projectId,
          query,
          this.buildHandoverReadHeaders(ctx),
        );
        return {
          ...res.body,
          ...(res.etag ? { etag: res.etag } : {}),
        };
      }

      case 'continuum_get_handover': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const handoverId = assertObjectId(args.handoverId, 'handoverId');
        const res = await this.handoverWorkflowService.getHandover(
          projectId,
          handoverId,
          this.buildHandoverReadHeaders(ctx),
        );
        return {
          ...res.body,
          ...(res.etag ? { etag: res.etag } : {}),
        };
      }

      case 'continuum_preview_departing_handover': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const departingUserId = assertObjectId(
          args.departingUserId,
          'departingUserId',
        );
        const handoverId = optionalObjectId(args.handoverId, 'handoverId');
        const res = await this.handoverWorkflowService.previewDepartingMember(
          projectId,
          {
            departingUserId,
            ...(handoverId ? { handoverId } : {}),
          },
          this.buildHandoverReadHeaders(ctx),
        );
        const allowedProjects = ctx.actor.mcpGrant?.allowedProjectIds;
        if (Array.isArray(allowedProjects)) {
          const allowedSet = new Set(
            allowedProjects.map((id) => id.trim().toLowerCase()),
          );
          return {
            ...res.body,
            relatedProjects: Array.isArray(res.body.relatedProjects)
              ? res.body.relatedProjects.filter(
                  (p) =>
                    typeof p?.projectId === 'string' &&
                    allowedSet.has(p.projectId.toLowerCase()),
                )
              : [],
          };
        }
        return res.body;
      }

      case 'continuum_create_and_bundle_handover': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const departingUserId = assertObjectId(
          args.departingUserId,
          'departingUserId',
        );
        const assignedLeaderId = assertObjectId(
          args.assignedLeaderId,
          'assignedLeaderId',
        );
        const successorUserId =
          args.successorUserId === undefined || args.successorUserId === null
            ? null
            : assertObjectId(args.successorUserId, 'successorUserId');
        const callerIdempotencyKey = asOptionalString(args.idempotencyKey);
        const created = await this.handoverWorkflowService.createHandover(
          projectId,
          {
            departingUserId,
            assignedLeaderId,
            successorUserId,
            teamId: null,
            targetCompletionDate: args.targetCompletionDate,
            title: args.title,
          },
          this.buildHandoverMutationHeaders(ctx, {
            idempotencyKey: callerIdempotencyKey,
            stepSuffix: 'create',
          }),
        );

        const shouldAutoBundle =
          args.publishImmediately === true ||
          args.taskIds !== undefined ||
          args.selectedSources !== undefined;

        if (!shouldAutoBundle) {
          return {
            receipt: created.body,
            ...(created.etag ? { etag: created.etag } : {}),
          };
        }

        const latest = await this.handoverWorkflowService.getHandover(
          projectId,
          created.body.handoverId,
          this.buildHandoverReadHeaders(ctx),
        );
        const isReplayed =
          created.replayed === true || created.body?.replayed === true;
        const alreadyPublished =
          Boolean(latest.body?.publishedRevision) ||
          Boolean(latest.body?.handover?.publishedRevisionId);
        if (isReplayed && alreadyPublished) {
          return {
            receipt: created.body,
            detail: latest.body,
            ...(latest.etag ? { etag: latest.etag } : {}),
          };
        }

        const bundled = await this.handoverWorkflowService.autoBundleAndPublish(
          projectId,
          created.body.handoverId,
          {
            ...(args.taskIds !== undefined ? { taskIds: args.taskIds } : {}),
            ...(args.selectedSources !== undefined
              ? { selectedSources: args.selectedSources }
              : {}),
          },
          this.buildHandoverMutationHeaders(ctx, {
            ifMatch: latest.etag ?? created.etag,
            idempotencyKey: callerIdempotencyKey,
            stepSuffix: 'bundle',
          }),
        );
        return {
          receipt: created.body,
          detail: bundled.body,
          ...(bundled.etag ? { etag: bundled.etag } : {}),
        };
      }

      case 'continuum_act_on_handover': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        const handoverId = assertObjectId(args.handoverId, 'handoverId');
        const action = args.action;

        let ifMatch = normalizeIfMatch(args.ifMatch);
        let currentDetail: Awaited<
          ReturnType<HandoverWorkflowService['getHandover']>
        > | null = null;

        if (
          !ifMatch ||
          (action === 'COMPLETE' &&
            (args.revisionId === undefined ||
              args.assignmentVersion === undefined))
        ) {
          currentDetail = await this.handoverWorkflowService.getHandover(
            projectId,
            handoverId,
            this.buildHandoverReadHeaders(ctx),
          );
          if (!ifMatch) {
            ifMatch = currentDetail.etag;
          }
        }

        const mutationHeaders = this.buildHandoverMutationHeaders(ctx, {
          ifMatch,
          idempotencyKey: asOptionalString(args.idempotencyKey),
          stepSuffix: `act:${String(action)}`,
        });

        switch (action) {
          case 'AUTO_BUNDLE': {
            const res = await this.handoverWorkflowService.autoBundleAndPublish(
              projectId,
              handoverId,
              {
                ...(args.taskIds !== undefined
                  ? { taskIds: args.taskIds }
                  : {}),
                ...(args.selectedSources !== undefined
                  ? { selectedSources: args.selectedSources }
                  : {}),
              },
              mutationHeaders,
            );
            return { ...res.body, ...(res.etag ? { etag: res.etag } : {}) };
          }

          case 'QUICK_TRANSFER_TASKS': {
            const res =
              await this.handoverWorkflowService.quickTransferHandoverTasks(
                projectId,
                handoverId,
                {
                  ...(args.taskIds !== undefined
                    ? { taskIds: args.taskIds }
                    : {}),
                },
                mutationHeaders,
              );
            return {
              transfer: res.body,
              ...(res.etag ? { etag: res.etag } : {}),
            };
          }

          case 'QUICK_ACCEPT': {
            const acceptNote =
              asOptionalString(args.reviewNote) ?? asOptionalString(args.note);
            const res = await this.handoverWorkflowService.quickAcceptHandover(
              projectId,
              handoverId,
              {
                ...(acceptNote !== undefined ? { note: acceptNote } : {}),
              },
              mutationHeaders,
            );
            return { ...res.body, ...(res.etag ? { etag: res.etag } : {}) };
          }

          case 'COMPLETE': {
            const revisionId =
              typeof args.revisionId === 'string'
                ? args.revisionId
                : currentDetail?.body.handover.publishedRevisionId;
            const assignmentVersion =
              typeof args.assignmentVersion === 'number'
                ? args.assignmentVersion
                : currentDetail?.body.handover.assignmentVersion;
            const reviewNote =
              typeof args.reviewNote === 'string' && args.reviewNote.trim()
                ? args.reviewNote
                : typeof args.note === 'string' && args.note.trim()
                  ? args.note
                  : 'Completed via Continuum MCP.';
            const res = await this.handoverWorkflowService.completeHandover(
              projectId,
              handoverId,
              {
                revisionId,
                assignmentVersion,
                reviewNote,
              },
              mutationHeaders,
            );
            return { ...res.body, ...(res.etag ? { etag: res.etag } : {}) };
          }

          case 'CANCEL': {
            const reason =
              typeof args.reason === 'string' && args.reason.trim()
                ? args.reason
                : 'Cancelled via Continuum MCP.';
            const res = await this.handoverWorkflowService.cancelHandover(
              projectId,
              handoverId,
              { reason },
              mutationHeaders,
            );
            return { ...res.body, ...(res.etag ? { etag: res.etag } : {}) };
          }

          default:
            throw new BadRequestException({
              code: 'VALIDATION_FAILED',
              message:
                'action must be one of AUTO_BUNDLE, QUICK_TRANSFER_TASKS, QUICK_ACCEPT, COMPLETE, CANCEL.',
            });
        }
      }

      // ---------------------------------------------------------------------
      // 5. SAG Knowledge & Grounded AI Q&A
      // ---------------------------------------------------------------------
      case 'continuum_search_knowledge': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        return this.aiChatService.searchKnowledge(this.buildAiHeaders(ctx), {
          projectId,
          query: typeof args.query === 'string' ? args.query : '',
          ...(args.topK !== undefined ? { topK: args.topK as number } : {}),
          ...(args.retrievalMode !== undefined
            ? { retrievalMode: args.retrievalMode as string }
            : {}),
          ...(args.sourceIds !== undefined
            ? { sourceIds: args.sourceIds as string[] }
            : {}),
        });
      }

      case 'continuum_ask_knowledge': {
        const projectId = assertObjectId(args.projectId, 'projectId');
        return this.aiChatService.askKnowledgeQuestion(
          this.buildAiHeaders(ctx),
          {
            projectId,
            query: typeof args.query === 'string' ? args.query : '',
            ...(typeof args.threadId === 'string'
              ? { threadId: args.threadId }
              : {}),
            ...(typeof args.persistThread === 'boolean'
              ? { persistThread: args.persistThread }
              : {}),
          },
        );
      }

      // ---------------------------------------------------------------------
      // 6. Human Chat & Notifications
      // ---------------------------------------------------------------------
      case 'continuum_chat': {
        const credentials = {
          authorization: ctx.authorizationHeader,
          cookie: ctx.cookieHeader,
        };
        const limit =
          args.limit !== undefined
            ? positiveInt(args.limit, 20, 100, 'limit')
            : undefined;
        const limitStr = limit !== undefined ? String(limit) : undefined;

        switch (args.action) {
          case 'LIST_CONVERSATIONS': {
            return this.chatService.listConversations(credentials, {
              ...(typeof args.search === 'string'
                ? { search: args.search }
                : {}),
              ...(typeof args.cursor === 'string'
                ? { cursor: args.cursor }
                : {}),
              ...(limitStr ? { limit: limitStr } : {}),
              ...(typeof args.archived === 'boolean'
                ? { archived: String(args.archived) }
                : {}),
            });
          }

          case 'LIST_MESSAGES': {
            const conversationId = assertObjectId(
              args.conversationId,
              'conversationId',
            );
            return this.chatService.listMessages(credentials, conversationId, {
              ...(typeof args.cursor === 'string'
                ? { cursor: args.cursor }
                : {}),
              ...(limitStr ? { limit: limitStr } : {}),
            });
          }

          case 'SEARCH_MESSAGES': {
            const q =
              typeof args.query === 'string'
                ? args.query
                : typeof args.search === 'string'
                  ? args.search
                  : '';
            if (args.conversationId !== undefined) {
              const conversationId = assertObjectId(
                args.conversationId,
                'conversationId',
              );
              return this.chatService.searchMessages(
                credentials,
                conversationId,
                {
                  q,
                  ...(typeof args.cursor === 'string'
                    ? { cursor: args.cursor }
                    : {}),
                  ...(limitStr ? { limit: limitStr } : {}),
                },
              );
            }
            return this.chatFeaturesService.search(credentials, {
              q,
              ...(typeof args.cursor === 'string'
                ? { cursor: args.cursor }
                : {}),
              ...(limitStr ? { limit: limitStr } : {}),
            });
          }

          case 'SEND_MESSAGE': {
            const conversationId = assertObjectId(
              args.conversationId,
              'conversationId',
            );
            if (
              typeof args.content !== 'string' ||
              args.content.trim().length < 1
            ) {
              throw new BadRequestException({
                code: 'VALIDATION_FAILED',
                message: 'content is required when sending a chat message.',
              });
            }
            return this.chatService.sendMessage(credentials, conversationId, {
              clientMessageId: randomUUID(),
              content: args.content,
              ...(args.replyToMessageId !== undefined
                ? { replyToMessageId: args.replyToMessageId }
                : {}),
              ...(args.mentionUserIds !== undefined
                ? { mentionUserIds: args.mentionUserIds }
                : {}),
            });
          }

          default:
            throw new BadRequestException({
              code: 'VALIDATION_FAILED',
              message:
                'action must be LIST_CONVERSATIONS, LIST_MESSAGES, SEARCH_MESSAGES, or SEND_MESSAGE.',
            });
        }
      }

      case 'continuum_notifications': {
        const allowedProjects = ctx.actor.mcpGrant?.allowedProjectIds;
        const isProjectRestricted = Array.isArray(allowedProjects);
        const allowedSet = isProjectRestricted
          ? new Set(allowedProjects.map((id) => id.trim().toLowerCase()))
          : null;

        switch (args.action) {
          case 'LIST': {
            const limit = positiveInt(args.limit, 20, 50, 'limit');
            if (allowedSet && allowedSet.size === 0) {
              return { items: [], nextCursor: null, unreadCount: 0 };
            }
            const res = await this.notificationService.listForUser(
              ctx.actor.id,
              {
                limit,
                ...(typeof args.unreadOnly === 'boolean'
                  ? { unreadOnly: args.unreadOnly }
                  : {}),
                ...(typeof args.cursor === 'string'
                  ? { cursor: args.cursor }
                  : {}),
                ...(isProjectRestricted
                  ? { allowedProjectIds: allowedProjects }
                  : {}),
              },
              ctx.actor.organizationId,
            );
            if (!allowedSet) {
              return res;
            }
            const filteredItems = res.items.filter(
              (item) =>
                typeof item.projectId === 'string' &&
                allowedSet.has(item.projectId.toLowerCase()),
            );
            const unreadCount =
              filteredItems.length !== res.items.length
                ? filteredItems.filter((item) => !item.readAt).length
                : res.unreadCount;
            return {
              ...res,
              items: filteredItems,
              unreadCount,
            };
          }

          case 'UNREAD_COUNT': {
            if (isProjectRestricted) {
              if (allowedSet && allowedSet.size === 0) {
                return { count: 0 };
              }
              return this.notificationService.getUnreadCount(
                ctx.actor.id,
                ctx.actor.organizationId,
                allowedProjects,
              );
            }
            return this.notificationService.getUnreadCount(
              ctx.actor.id,
              ctx.actor.organizationId,
            );
          }

          case 'MARK_READ': {
            const notificationId = assertObjectId(
              args.notificationId,
              'notificationId',
            );
            if (allowedSet) {
              const target = await this.notificationService.findForUser(
                ctx.actor.id,
                notificationId,
                ctx.actor.organizationId,
              );
              if (
                !target ||
                typeof target.projectId !== 'string' ||
                !allowedSet.has(target.projectId.toLowerCase())
              ) {
                throw new McpScopeForbiddenError(
                  `MCP API key is not authorized to mark notification '${notificationId}' as read outside its allowed projects.`,
                );
              }
            }
            return this.notificationService.markAsRead(
              ctx.actor.id,
              notificationId,
              ctx.actor.organizationId,
            );
          }

          case 'MARK_ALL_READ': {
            if (isProjectRestricted) {
              throw new McpScopeForbiddenError(
                'MARK_ALL_READ is organization-wide; use MARK_READ for specific project notifications when using a project-restricted key.',
              );
            }
            return this.notificationService.markAllAsRead(
              ctx.actor.id,
              ctx.actor.organizationId,
            );
          }

          default:
            throw new BadRequestException({
              code: 'VALIDATION_FAILED',
              message:
                'action must be LIST, UNREAD_COUNT, MARK_READ, or MARK_ALL_READ.',
            });
        }
      }

      default:
        throw new McpJsonRpcError(
          JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          `Unhandled tool: ${toolName}`,
        );
    }
  }
}
