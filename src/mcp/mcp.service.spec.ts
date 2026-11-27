/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest asymmetric matchers are typed as any. */
import {
  ForbiddenException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { McpService } from './mcp.service';
import { validateMcpToolArguments } from './mcp-schema-validator';
import { McpToolsService } from './mcp-tools.service';
import { MCP_TOOLS_CATALOG } from './mcp-tools.catalog';
import type { AuthenticatedIdentity } from '../services/iam/application/authentication/authentication.application.service';

const USER_ID = '651a2b3c4d5e6f7a8b9c0d1e';
const LEADER_ID = '651a2b3c4d5e6f7a8b9c0d22';
const SUCCESSOR_ID = '651a2b3c4d5e6f7a8b9c0d33';
const ORG_ID = '651a2b3c4d5e6f7a8b9c0d1f';
const PROJECT_ID = '651a2b3c4d5e6f7a8b9c0da1';
const FORBIDDEN_PROJECT_ID = '651a2b3c4d5e6f7a8b9c0db2';
const TASK_ID = '651a2b3c4d5e6f7a8b9c0dc3';
const NOTE_ID = '651a2b3c4d5e6f7a8b9c0dd4';
const HANDOVER_ID = '651a2b3c4d5e6f7a8b9c0de5';
const CONV_ID = '651a2b3c4d5e6f7a8b9c0df6';

const CANONICAL_36_TOOLS = [
  'continuum_get_context',
  'continuum_list_projects',
  'continuum_get_project',
  'continuum_list_project_members',
  'continuum_create_project',
  'continuum_update_project',
  'continuum_manage_project_members',
  'continuum_list_tasks',
  'continuum_get_task',
  'continuum_get_project_task_summary',
  'continuum_list_sprints',
  'continuum_create_task',
  'continuum_update_task',
  'continuum_transition_task',
  'continuum_add_task_comment',
  'continuum_list_work_notes',
  'continuum_get_work_note',
  'continuum_create_work_note',
  'continuum_review_work_note',
  'continuum_list_documents',
  'continuum_get_document',
  'continuum_create_document',
  'continuum_upload_document_file',
  'continuum_review_document',
  'continuum_list_work_reports',
  'continuum_save_work_report_draft',
  'continuum_review_work_report',
  'continuum_list_handovers',
  'continuum_get_handover',
  'continuum_preview_departing_handover',
  'continuum_create_and_bundle_handover',
  'continuum_act_on_handover',
  'continuum_search_knowledge',
  'continuum_ask_knowledge',
  'continuum_chat',
  'continuum_notifications',
];

describe('McpService & McpToolsService (Packet C)', () => {
  const fullActor: AuthenticatedIdentity = {
    id: USER_ID,
    email: 'leader@continuum.ai',
    name: 'Project Leader',
    organizationId: ORG_ID,
    roles: ['ADMIN', 'MEMBER'],
    mcpGrant: {
      keyId: '651a2b3c4d5e6f7a8b9c0d99',
      scope: 'FULL_OPERATIONS',
      allowedProjectIds: [PROJECT_ID],
    },
  };

  const orgWideFullActor: AuthenticatedIdentity = {
    ...fullActor,
    mcpGrant: {
      keyId: '651a2b3c4d5e6f7a8b9c0daa',
      scope: 'FULL_OPERATIONS',
      allowedProjectIds: null,
    },
  };

  function createHarness() {
    const projectService = {
      list: jest.fn().mockResolvedValue({
        data: [
          {
            id: PROJECT_ID,
            organizationId: ORG_ID,
            name: 'Alpha',
            code: 'ALP',
            status: 'ACTIVE',
            visibility: 'PRIVATE',
          },
        ],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      }),
      get: jest.fn().mockResolvedValue({
        id: PROJECT_ID,
        organizationId: ORG_ID,
        name: 'Alpha',
        code: 'ALP',
        status: 'ACTIVE',
        visibility: 'PRIVATE',
      }),
      create: jest.fn().mockResolvedValue({
        id: PROJECT_ID,
        organizationId: ORG_ID,
        name: 'New Project',
        code: 'NEWPROJ',
        status: 'ACTIVE',
        visibility: 'PRIVATE',
      }),
    };
    const projectAccessService = {
      listMembers: jest.fn().mockResolvedValue({
        data: [{ userId: USER_ID, status: 'ACTIVE' }],
        pagination: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 },
      }),
      listLeaders: jest.fn().mockResolvedValue({
        data: [{ userId: LEADER_ID, fullName: 'Leader' }],
      }),
      updateSettings: jest.fn().mockResolvedValue({
        id: PROJECT_ID,
        organizationId: ORG_ID,
        name: 'Alpha Renamed',
        code: 'ALP',
        status: 'ACTIVE',
        visibility: 'PRIVATE',
      }),
      changeVisibility: jest.fn().mockResolvedValue({
        id: PROJECT_ID,
        organizationId: ORG_ID,
        name: 'Alpha Renamed',
        code: 'ALP',
        status: 'ACTIVE',
        visibility: 'PUBLIC',
      }),
      listMemberCandidates: jest.fn().mockResolvedValue({
        data: [{ id: SUCCESSOR_ID, email: 'member@continuum.ai' }],
      }),
      listLeaderCandidates: jest.fn().mockResolvedValue({
        data: [{ id: LEADER_ID, email: 'leader@continuum.ai' }],
      }),
      addMember: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d11',
        userId: SUCCESSOR_ID,
        role: 'MEMBER',
        status: 'ACTIVE',
      }),
      removeMember: jest.fn().mockResolvedValue(undefined),
      assignLeader: jest.fn().mockResolvedValue(undefined),
      changeLeader: jest.fn().mockResolvedValue(undefined),
      revokeLeader: jest.fn().mockResolvedValue(undefined),
    };
    const taskWorkspaceService = {
      listProjectTasks: jest.fn().mockResolvedValue({
        statusCode: 200,
        body: { items: [{ id: TASK_ID, title: 'Task 1' }], nextAfterId: null },
      }),
      getProjectTask: jest.fn().mockResolvedValue({
        statusCode: 200,
        etag: `"task:${TASK_ID}:3"`,
        body: { id: TASK_ID, title: 'Task 1', version: 3, status: 'TODO' },
      }),
      getProjectTaskSummary: jest.fn().mockResolvedValue({
        statusCode: 200,
        body: { total: 5, byStatus: { TODO: 2, DONE: 3 } },
      }),
      listProjectSprints: jest.fn().mockResolvedValue({
        statusCode: 200,
        body: { items: [{ id: '651a2b3c4d5e6f7a8b9c0d88', name: 'Sprint 1' }] },
      }),
      createProjectTask: jest.fn().mockResolvedValue({
        statusCode: 201,
        etag: `"task:${TASK_ID}:1"`,
        body: { id: TASK_ID, title: 'New Task', version: 1 },
      }),
      updateProjectTask: jest.fn().mockResolvedValue({
        statusCode: 200,
        etag: `"task:${TASK_ID}:4"`,
        body: { id: TASK_ID, title: 'Updated Task', version: 4 },
      }),
      transitionProjectTask: jest.fn().mockResolvedValue({
        statusCode: 200,
        etag: `"task:${TASK_ID}:4"`,
        body: { id: TASK_ID, status: 'IN_PROGRESS', version: 4 },
      }),
      createTaskComment: jest.fn().mockResolvedValue({
        statusCode: 201,
        body: { id: '651a2b3c4d5e6f7a8b9c0d77', body: 'LGTM' },
      }),
      listTaskComments: jest.fn().mockResolvedValue({
        statusCode: 200,
        body: { items: [], nextAfterId: null },
      }),
      listTaskHistory: jest.fn().mockResolvedValue({
        statusCode: 200,
        body: { data: [], pagination: { page: 1, limit: 20, hasNext: false } },
      }),
    };
    const workNotesService = {
      listProjectTaskNotes: jest.fn().mockResolvedValue({
        data: [{ id: NOTE_ID, title: 'Note 1' }],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      }),
      getTaskNote: jest
        .fn()
        .mockResolvedValue({ id: NOTE_ID, title: 'Note 1' }),
      getProjectTaskNote: jest
        .fn()
        .mockResolvedValue({ id: NOTE_ID, title: 'Note 1' }),
      createTaskNote: jest
        .fn()
        .mockResolvedValue({ id: NOTE_ID, title: 'Created Note' }),
      reviewTaskNote: jest.fn().mockResolvedValue({
        id: NOTE_ID,
        title: 'Created Note',
        reviewStatus: 'APPROVED',
      }),
      listDocuments: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      getDocument: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d66',
        title: 'Architecture Spec',
        status: 'DRAFT',
      }),
      getDocumentKnowledgeStatus: jest.fn().mockResolvedValue({
        documentId: '651a2b3c4d5e6f7a8b9c0d66',
        version: 1,
        status: 'INDEXED',
        searchStatus: 'READY',
        knowledgeStatus: 'READY',
        searchReady: true,
        knowledgeReady: true,
        progress: 100,
      }),
      createDocument: jest
        .fn()
        .mockResolvedValue({ id: '651a2b3c4d5e6f7a8b9c0d66', status: 'DRAFT' }),
      uploadDocumentFile: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d66',
        status: 'DRAFT',
        file: { name: 'spec.md', contentType: 'text/markdown', size: 12 },
      }),
      updateDocumentDraft: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d66',
        title: 'Updated Spec',
        status: 'DRAFT',
      }),
      commentDocument: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d66',
        status: 'PENDING_REVIEW',
      }),
      reviewDocument: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d66',
        status: 'APPROVED',
      }),
      archiveDocument: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d66',
        status: 'ARCHIVED',
      }),
      syncDocumentToSag: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d66',
        status: 'APPROVED',
      }),
      controlDocumentKnowledge: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d66',
        status: 'APPROVED',
      }),
      submitDocument: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d66',
        status: 'PENDING_REVIEW',
      }),
      listWorkReports: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      saveCurrentWorkReportDraft: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d55',
        status: 'DRAFT',
      }),
      updateWorkReportDraft: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d55',
        status: 'DRAFT',
      }),
      submitWorkReport: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d55',
        status: 'PENDING_REVIEW',
      }),
      reviewWorkReport: jest.fn().mockResolvedValue({
        id: '651a2b3c4d5e6f7a8b9c0d55',
        status: 'APPROVED',
      }),
    };
    const handoverWorkflowService = {
      listHandovers: jest.fn().mockResolvedValue({
        body: { data: [], nextCursor: null },
        etag: `"handover:${PROJECT_ID}:1"`,
      }),
      getHandover: jest.fn().mockResolvedValue({
        body: {
          handover: {
            id: HANDOVER_ID,
            version: 2,
            status: 'OPEN',
            publishedRevisionId: '651a2b3c4d5e6f7a8b9c0d44',
            assignmentVersion: 1,
          },
          publishedRevision: null,
          capabilities: ['READ'],
          requiredPendingCount: 0,
          canComplete: true,
        },
        etag: `"handover:${HANDOVER_ID}:2"`,
      }),
      previewDepartingMember: jest.fn().mockResolvedValue({
        body: {
          departingUserId: USER_ID,
          projectId: PROJECT_ID,
          relatedProjects: [],
          tasks: [],
          sources: [],
        },
      }),
      createHandover: jest.fn().mockResolvedValue({
        body: {
          operationId: 'op-1',
          handoverId: HANDOVER_ID,
          version: 1,
          status: 'OPEN',
          revisionId: null,
          replayed: false,
        },
        etag: `"handover:${HANDOVER_ID}:1"`,
      }),
      autoBundleAndPublish: jest.fn().mockResolvedValue({
        body: {
          handover: { id: HANDOVER_ID, version: 2, status: 'OPEN' },
        },
        etag: `"handover:${HANDOVER_ID}:2"`,
      }),
      quickTransferHandoverTasks: jest.fn().mockResolvedValue({
        body: { id: 'tr-1', status: 'COMPLETED' },
        etag: `"handover:${HANDOVER_ID}:3"`,
      }),
      quickAcceptHandover: jest.fn().mockResolvedValue({
        body: { handover: { id: HANDOVER_ID, version: 3, status: 'OPEN' } },
        etag: `"handover:${HANDOVER_ID}:3"`,
      }),
      completeHandover: jest.fn().mockResolvedValue({
        body: {
          operationId: 'op-complete',
          handoverId: HANDOVER_ID,
          version: 4,
          status: 'COMPLETED',
          revisionId: '651a2b3c4d5e6f7a8b9c0d44',
          replayed: false,
        },
        etag: `"handover:${HANDOVER_ID}:4"`,
      }),
      cancelHandover: jest.fn().mockResolvedValue({
        body: {
          operationId: 'op-cancel',
          handoverId: HANDOVER_ID,
          version: 4,
          status: 'CANCELLED',
          revisionId: null,
          replayed: false,
        },
        etag: `"handover:${HANDOVER_ID}:4"`,
      }),
    };
    const aiChatService = {
      searchKnowledge: jest.fn().mockResolvedValue({
        query: 'auth flow',
        summary: 'Uses JWT + MCP keys [1].',
        answerStatus: 'answered',
        noAnswerReason: null,
        degraded: false,
        degradedReason: null,
        sections: [],
        citations: [],
      }),
      askKnowledgeQuestion: jest.fn().mockResolvedValue({
        threadId: 'thread_1',
        threadPersisted: false,
        messageId: 'msg_1',
        answer: 'Detailed grounded answer [1].',
        answerStatus: 'answered',
        citations: [],
        retrievalSteps: [],
      }),
    };
    const chatService = {
      listConversations: jest
        .fn()
        .mockResolvedValue({ data: [{ id: CONV_ID }], nextCursor: null }),
      listMessages: jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
      searchMessages: jest
        .fn()
        .mockResolvedValue({ data: [], nextCursor: null }),
      sendMessage: jest
        .fn()
        .mockResolvedValue({ id: 'msg_chat_1', content: 'Hello team!' }),
    };
    const chatFeaturesService = {
      search: jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
    };
    const notificationService = {
      listForUser: jest.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        unreadCount: 0,
      }),
      getUnreadCount: jest.fn().mockResolvedValue({ count: 2 }),
      findForUser: jest.fn().mockResolvedValue({
        id: NOTE_ID,
        projectId: PROJECT_ID,
        readAt: null,
      }),
      markAsRead: jest.fn().mockResolvedValue({ id: NOTE_ID, readAt: 'now' }),
      markAllAsRead: jest
        .fn()
        .mockResolvedValue({ updatedCount: 2, readAt: 'now' }),
    };

    const authorizationEvidence = {
      loadProjectCreate: jest.fn().mockResolvedValue({
        membership: {
          userId: USER_ID,
          organizationId: ORG_ID,
          status: 'ACTIVE',
        },
        explicitDeny: { denied: false },
      }),
      loadProjectAccess: jest.fn().mockResolvedValue({
        project: {
          id: PROJECT_ID,
          organizationId: ORG_ID,
          status: 'ACTIVE',
          visibility: 'PRIVATE',
        },
        membership: {
          userId: USER_ID,
          organizationId: ORG_ID,
          status: 'ACTIVE',
        },
        projectMembership: {
          userId: USER_ID,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          status: 'ACTIVE',
        },
        assignments: [{ role: 'ADMIN', scope: 'ORGANIZATION' }],
        explicitDeny: { denied: false },
      }),
    };
    const authorizationPolicy = {
      evaluate: jest.fn().mockReturnValue({ allowed: true }),
      evaluateProjectAccess: jest.fn().mockReturnValue({ allowed: true }),
    };

    const toolsService = new McpToolsService(
      projectService as never,
      projectAccessService as never,
      taskWorkspaceService as never,
      workNotesService as never,
      handoverWorkflowService as never,
      aiChatService as never,
      chatService as never,
      chatFeaturesService as never,
      notificationService as never,
      authorizationEvidence as never,
      authorizationPolicy as never,
    );
    const mcpService = new McpService(toolsService);

    return {
      mcpService,
      toolsService,
      projectService,
      projectAccessService,
      taskWorkspaceService,
      workNotesService,
      handoverWorkflowService,
      aiChatService,
      chatService,
      chatFeaturesService,
      notificationService,
      authorizationEvidence,
      authorizationPolicy,
    };
  }

  it('registers all 36 canonical tools with valid JSON Schema and MCP annotations', () => {
    expect(MCP_TOOLS_CATALOG).toHaveLength(36);
    expect(MCP_TOOLS_CATALOG.map((t) => t.name)).toEqual(CANONICAL_36_TOOLS);
    for (const tool of MCP_TOOLS_CATALOG) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.annotations).toEqual(
        expect.objectContaining({
          title: expect.any(String),
          readOnlyHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          idempotentHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
        }),
      );
    }
  });

  it('handles initialize, notifications, ping, batch JSON-RPC, resources, and prompts', async () => {
    const { mcpService } = createHarness();
    const ctx = {
      actor: fullActor,
      authorizationHeader: 'Bearer ctm_mcp_test',
    };

    const initRes = await mcpService.handlePayload(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(initRes.kind).toBe('response');
    if (initRes.kind === 'response' && !Array.isArray(initRes.body)) {
      expect(initRes.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'continuum-mcp', version: '1.0.0' },
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
        },
      });
    }

    const notifRes = await mcpService.handlePayload(ctx, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notifRes.kind).toBe('accepted');

    const batchRes = await mcpService.handlePayload(ctx, [
      { jsonrpc: '2.0', id: 'p1', method: 'ping' },
      { jsonrpc: '2.0', id: 'r1', method: 'resources/list' },
      { jsonrpc: '2.0', id: 'rt1', method: 'resources/templates/list' },
      { jsonrpc: '2.0', id: 'pr1', method: 'prompts/list' },
    ]);
    expect(batchRes.kind).toBe('response');
    if (batchRes.kind !== 'response') throw new Error('Expected response');
    expect(Array.isArray(batchRes.body)).toBe(true);
    expect(batchRes.body).toHaveLength(4);

    // Read resources
    const readCtx = await mcpService.handlePayload(ctx, {
      jsonrpc: '2.0',
      id: 'read-1',
      method: 'resources/read',
      params: { uri: 'continuum://context/current' },
    });
    expect(JSON.stringify(readCtx)).toContain('leader@continuum.ai');

    const readProj = await mcpService.handlePayload(ctx, {
      jsonrpc: '2.0',
      id: 'read-2',
      method: 'resources/read',
      params: { uri: `continuum://projects/${PROJECT_ID}/overview` },
    });
    expect(JSON.stringify(readProj)).toContain('Alpha');

    // Get prompt
    const promptRes = await mcpService.handlePayload(ctx, {
      jsonrpc: '2.0',
      id: 'pr-get',
      method: 'prompts/get',
      params: {
        name: 'daily-standup-brief',
        arguments: { projectId: PROJECT_ID },
      },
    });
    expect(JSON.stringify(promptRes)).toContain(PROJECT_ID);
  });

  it('filters tools/list by scope tier and rejects unauthorized scope or project on tools/call with MCP_SCOPE_FORBIDDEN', async () => {
    const { mcpService, taskWorkspaceService, chatService } = createHarness();

    const readOnlyCtx = {
      actor: {
        ...fullActor,
        mcpGrant: {
          keyId: 'k1',
          scope: 'READ_ONLY' as const,
          allowedProjectIds: [PROJECT_ID],
        },
      },
      authorizationHeader: 'Bearer ctm_mcp_ro',
    };

    const listRes = await mcpService.handlePayload(readOnlyCtx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    if (listRes.kind !== 'response') throw new Error('Expected response');
    const listedNames = (
      (listRes.body as { result: { tools: Array<{ name: string }> } }).result
        .tools ?? []
    ).map((t) => t.name);

    expect(listedNames).toContain('continuum_get_context');
    expect(listedNames).toContain('continuum_search_knowledge');
    expect(listedNames).not.toContain('continuum_chat');
    expect(listedNames).not.toContain('continuum_create_task');
    expect(listedNames).not.toContain('continuum_create_and_bundle_handover');

    // Organization-wide READ_ONLY key DOES see continuum_chat in tools/list
    const orgWideReadOnlyList = await mcpService.handlePayload(
      {
        actor: {
          ...orgWideFullActor,
          mcpGrant: {
            keyId: 'k1-org',
            scope: 'READ_ONLY' as const,
            allowedProjectIds: null,
          },
        },
        authorizationHeader: 'Bearer ctm_mcp_ro_org',
      },
      { jsonrpc: '2.0', id: 11, method: 'tools/list' },
    );
    if (orgWideReadOnlyList.kind !== 'response')
      throw new Error('Expected response');
    const orgWideListedNames = (
      (
        orgWideReadOnlyList.body as {
          result: { tools: Array<{ name: string }> };
        }
      ).result.tools ?? []
    ).map((t) => t.name);
    expect(orgWideListedNames).toContain('continuum_chat');

    // Calling READ_WRITE tool with READ_ONLY key -> isError: true + MCP_SCOPE_FORBIDDEN
    const deniedWrite = await mcpService.handlePayload(readOnlyCtx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'continuum_create_task',
        arguments: { projectId: PROJECT_ID, title: 'Unauthorized' },
      },
    });
    if (deniedWrite.kind !== 'response') throw new Error('Expected response');
    expect(deniedWrite.body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
      },
    });
    expect(taskWorkspaceService.createProjectTask).not.toHaveBeenCalled();

    // Calling continuum_chat SEND_MESSAGE with READ_WRITE key -> requires FULL_OPERATIONS -> MCP_SCOPE_FORBIDDEN
    const readWriteCtx = {
      actor: {
        ...fullActor,
        mcpGrant: {
          keyId: 'k2',
          scope: 'READ_WRITE' as const,
          allowedProjectIds: [PROJECT_ID],
        },
      },
      authorizationHeader: 'Bearer ctm_mcp_rw',
    };
    const deniedChatSend = await mcpService.handlePayload(readWriteCtx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'continuum_chat',
        arguments: {
          action: 'SEND_MESSAGE',
          conversationId: CONV_ID,
          content: 'Attempted send',
        },
      },
    });
    if (deniedChatSend.kind !== 'response')
      throw new Error('Expected response');
    expect(deniedChatSend.body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
      },
    });
    expect(chatService.sendMessage).not.toHaveBeenCalled();

    // Calling project outside allowedProjectIds -> MCP_SCOPE_FORBIDDEN
    const deniedProject = await mcpService.handlePayload(readOnlyCtx, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'continuum_list_tasks',
        arguments: { projectId: FORBIDDEN_PROJECT_ID },
      },
    });
    if (deniedProject.kind !== 'response') throw new Error('Expected response');
    expect(deniedProject.body).toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
      },
    });
  });

  it('auto-resolves ETags, enforces projectService.get before listMembers, passes teamId: null on handover create, and generates UUIDv4 clientMessageId on chat send', async () => {
    const {
      toolsService,
      projectService,
      projectAccessService,
      taskWorkspaceService,
      handoverWorkflowService,
      chatService,
    } = createHarness();
    const ctx = {
      actor: fullActor,
      authorizationHeader: 'Bearer ctm_mcp_full',
    };

    // 1. continuum_list_project_members calls projectService.get BEFORE projectAccessService.listMembers
    await toolsService.callTool(ctx, 'continuum_list_project_members', {
      projectId: PROJECT_ID,
    });
    expect(projectService.get).toHaveBeenCalledWith(fullActor, PROJECT_ID);
    expect(projectAccessService.listMembers).toHaveBeenCalled();

    // 2. continuum_update_task auto-resolves ETag when ifMatch omitted
    await toolsService.callTool(ctx, 'continuum_update_task', {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      title: 'Refined Title',
    });
    expect(taskWorkspaceService.getProjectTask).toHaveBeenCalled();
    expect(taskWorkspaceService.updateProjectTask).toHaveBeenCalledWith(
      expect.objectContaining({
        ifMatchHeader: `"task:${TASK_ID}:3"`,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
      }),
    );

    // 3. continuum_transition_task auto-resolves ETag when ifMatch omitted
    await toolsService.callTool(ctx, 'continuum_transition_task', {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      toStatus: 'IN_PROGRESS',
    });
    expect(taskWorkspaceService.transitionProjectTask).toHaveBeenCalledWith(
      expect.objectContaining({
        ifMatchHeader: `"task:${TASK_ID}:3"`,
        body: { toStatus: 'IN_PROGRESS' },
      }),
    );

    // 4. continuum_create_and_bundle_handover passes teamId: null and calls autoBundleAndPublish when publishImmediately=true
    await toolsService.callTool(ctx, 'continuum_create_and_bundle_handover', {
      projectId: PROJECT_ID,
      departingUserId: USER_ID,
      assignedLeaderId: LEADER_ID,
      successorUserId: SUCCESSOR_ID,
      targetCompletionDate: '2026-12-31T00:00:00Z',
      title: 'Q4 Handover',
      publishImmediately: true,
    });
    expect(handoverWorkflowService.createHandover).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        teamId: null,
        departingUserId: USER_ID,
        assignedLeaderId: LEADER_ID,
        successorUserId: SUCCESSOR_ID,
      }),
      expect.objectContaining({
        csrfToken: expect.any(String),
      }),
    );
    expect(handoverWorkflowService.autoBundleAndPublish).toHaveBeenCalledWith(
      PROJECT_ID,
      HANDOVER_ID,
      {},
      expect.objectContaining({
        ifMatch: `"handover:${HANDOVER_ID}:2"`,
      }),
    );

    // 5. continuum_act_on_handover auto-resolves ETag & revisionId/assignmentVersion for COMPLETE
    await toolsService.callTool(ctx, 'continuum_act_on_handover', {
      projectId: PROJECT_ID,
      handoverId: HANDOVER_ID,
      action: 'COMPLETE',
      reviewNote: 'Verified all items.',
    });
    expect(handoverWorkflowService.completeHandover).toHaveBeenCalledWith(
      PROJECT_ID,
      HANDOVER_ID,
      {
        revisionId: '651a2b3c4d5e6f7a8b9c0d44',
        assignmentVersion: 1,
        reviewNote: 'Verified all items.',
      },
      expect.objectContaining({
        ifMatch: `"handover:${HANDOVER_ID}:2"`,
      }),
    );

    // 6. continuum_chat SEND_MESSAGE generates UUID v4 clientMessageId for organization-wide keys
    await toolsService.callTool(
      { actor: orgWideFullActor, authorizationHeader: 'Bearer ctm_mcp_org' },
      'continuum_chat',
      {
        action: 'SEND_MESSAGE',
        conversationId: CONV_ID,
        content: 'Standup summary posted via MCP',
      },
    );
    expect(chatService.sendMessage).toHaveBeenCalledWith(
      { authorization: 'Bearer ctm_mcp_org', cookie: undefined },
      CONV_ID,
      expect.objectContaining({
        clientMessageId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        content: 'Standup summary posted via MCP',
      }),
    );
  });

  it('enforces runtime inputSchema validation across all 36 tools, aliases unassigned/backlog, wraps unquoted ifMatch, and normalizes Unicode NFC (BE-2)', async () => {
    const {
      toolsService,
      projectService,
      taskWorkspaceService,
      workNotesService,
      handoverWorkflowService,
      chatService,
    } = createHarness();
    const ctx = {
      actor: orgWideFullActor,
      authorizationHeader: 'Bearer ctm_mcp_org',
    };

    // 1. Rejects unknown arguments (additionalProperties: false) without calling downstream services
    const updateWithStatus = await toolsService.callTool(
      ctx,
      'continuum_update_task',
      {
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        title: 'Updated Title',
        status: 'DONE',
      },
    );
    expect(updateWithStatus).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'MCP_INVALID_ARGUMENTS',
        message: expect.stringContaining("Unknown argument 'status'"),
      },
    });
    expect(taskWorkspaceService.updateProjectTask).not.toHaveBeenCalled();

    const listTasksTypo = await toolsService.callTool(
      ctx,
      'continuum_list_tasks',
      {
        projectId: PROJECT_ID,
        assignee: 'me',
      },
    );
    expect(listTasksTypo).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'MCP_INVALID_ARGUMENTS',
        message: expect.stringContaining("Unknown argument 'assignee'"),
      },
    });
    expect(taskWorkspaceService.listProjectTasks).not.toHaveBeenCalled();

    // 2. Rejects __proto__ and constructor own properties
    const protoPayload = JSON.parse(
      '{"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const protoRes = await toolsService.callTool(
      ctx,
      'continuum_get_context',
      protoPayload,
    );
    expect(protoRes).toMatchObject({
      isError: true,
      structuredContent: { code: 'MCP_INVALID_ARGUMENTS' },
    });

    const ctorRes = await toolsService.callTool(ctx, 'continuum_get_context', {
      constructor: { prototype: {} },
    });
    expect(ctorRes).toMatchObject({
      isError: true,
      structuredContent: { code: 'MCP_INVALID_ARGUMENTS' },
    });

    // 3. Enforces enum, integer bounds, minLength/maxLength, pattern, and nested object schemas
    for (const [toolName, badArgs] of [
      ['continuum_list_work_notes', { projectId: PROJECT_ID, sort: 'BOGUS' }],
      [
        'continuum_list_work_reports',
        { projectId: PROJECT_ID, scope: 'INVALID_SCOPE' },
      ],
      ['continuum_chat', { action: 'LIST_CONVERSATIONS', limit: 1.5 }],
      ['continuum_chat', { action: 'LIST_CONVERSATIONS', limit: -1 }],
      ['continuum_chat', { action: 'LIST_CONVERSATIONS', limit: 999999 }],
      ['continuum_list_tasks', { projectId: PROJECT_ID, q: 'x' }],
      ['continuum_list_tasks', { projectId: PROJECT_ID, q: 'x'.repeat(101) }],
      [
        'continuum_create_task',
        {
          projectId: PROJECT_ID,
          title: 'Nested bad step',
          steps: [{ text: 'Step 1', done: true, extraKey: 1 }],
        },
      ],
    ] as const) {
      const res = await toolsService.callTool(ctx, toolName, badArgs);
      expect(res).toMatchObject({
        isError: true,
        structuredContent: { code: 'MCP_INVALID_ARGUMENTS' },
      });
    }
    expect(workNotesService.listProjectTaskNotes).not.toHaveBeenCalled();
    expect(workNotesService.listWorkReports).not.toHaveBeenCalled();
    expect(chatService.listConversations).not.toHaveBeenCalled();

    // 4. Normalizes assigneeId='unassigned' -> 'none' and sprintId='backlog' -> 'none'
    await toolsService.callTool(ctx, 'continuum_list_tasks', {
      projectId: PROJECT_ID,
      assigneeId: 'unassigned',
      sprintId: 'backlog',
    });
    expect(taskWorkspaceService.listProjectTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        query: expect.objectContaining({
          assigneeId: 'none',
          sprintId: 'none',
        }),
      }),
    );

    // 5. Wraps unquoted task/handover ifMatch with double quotes automatically
    await toolsService.callTool(ctx, 'continuum_update_task', {
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      ifMatch: `task:${TASK_ID}:3`,
      title: 'Quoted ETag',
    });
    expect(taskWorkspaceService.updateProjectTask).toHaveBeenCalledWith(
      expect.objectContaining({
        ifMatchHeader: `"task:${TASK_ID}:3"`,
      }),
    );

    await toolsService.callTool(ctx, 'continuum_act_on_handover', {
      projectId: PROJECT_ID,
      handoverId: HANDOVER_ID,
      action: 'CANCEL',
      ifMatch: `handover:${HANDOVER_ID}:2`,
      reason: 'Re-planned',
    });
    expect(handoverWorkflowService.cancelHandover).toHaveBeenCalledWith(
      PROJECT_ID,
      HANDOVER_ID,
      { reason: 'Re-planned' },
      expect.objectContaining({
        ifMatch: `"handover:${HANDOVER_ID}:2"`,
      }),
    );

    // 6. Normalizes Vietnamese NFD -> NFC before trimming/searching
    const nfd = 'Ti\u0065\u0302\u0301ng Vi\u0065\u0323\u0302t';
    await toolsService.callTool(ctx, 'continuum_list_projects', { q: nfd });
    expect(projectService.list).toHaveBeenCalledWith(
      orgWideFullActor,
      expect.objectContaining({ q: nfd.normalize('NFC') }),
    );
  });

  it('closes all allowedProjectIds partition leaks across continuum_chat, continuum_notifications, and continuum_preview_departing_handover (BE-3)', async () => {
    const {
      toolsService,
      chatService,
      notificationService,
      handoverWorkflowService,
    } = createHarness();
    const scopedCtx = {
      actor: fullActor, // allowedProjectIds: [PROJECT_ID]
      authorizationHeader: 'Bearer ctm_mcp_scoped',
    };

    // 1. continuum_chat rejected with MCP_SCOPE_FORBIDDEN for project-restricted keys
    const chatDenied = await toolsService.callTool(
      scopedCtx,
      'continuum_chat',
      { action: 'LIST_CONVERSATIONS' },
    );
    expect(chatDenied).toMatchObject({
      isError: true,
      structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
    });
    expect(chatService.listConversations).not.toHaveBeenCalled();

    // 2. continuum_notifications filters LIST, scopes UNREAD_COUNT, guards MARK_READ, and blocks MARK_ALL_READ
    notificationService.listForUser.mockResolvedValueOnce({
      items: [
        { id: '651a2b3c4d5e6f7a8b9c0de1', projectId: PROJECT_ID, readAt: null },
        {
          id: '651a2b3c4d5e6f7a8b9c0de2',
          projectId: FORBIDDEN_PROJECT_ID,
          readAt: null,
        },
        { id: '651a2b3c4d5e6f7a8b9c0de3', projectId: null, readAt: null },
      ],
      nextCursor: null,
      unreadCount: 3,
    });
    const listNotif = await toolsService.callTool(
      scopedCtx,
      'continuum_notifications',
      { action: 'LIST' },
    );
    expect(listNotif).toMatchObject({
      structuredContent: {
        items: [{ id: '651a2b3c4d5e6f7a8b9c0de1', projectId: PROJECT_ID }],
        unreadCount: 1,
      },
    });

    await toolsService.callTool(scopedCtx, 'continuum_notifications', {
      action: 'UNREAD_COUNT',
    });
    expect(notificationService.getUnreadCount).toHaveBeenCalledWith(
      USER_ID,
      ORG_ID,
      [PROJECT_ID],
    );

    notificationService.findForUser.mockResolvedValueOnce({
      id: '651a2b3c4d5e6f7a8b9c0de2',
      projectId: FORBIDDEN_PROJECT_ID,
      readAt: null,
    });
    const markForbidden = await toolsService.callTool(
      scopedCtx,
      'continuum_notifications',
      {
        action: 'MARK_READ',
        notificationId: '651a2b3c4d5e6f7a8b9c0de2',
      },
    );
    expect(markForbidden).toMatchObject({
      isError: true,
      structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
    });
    expect(notificationService.markAsRead).not.toHaveBeenCalled();

    const markAllDenied = await toolsService.callTool(
      scopedCtx,
      'continuum_notifications',
      { action: 'MARK_ALL_READ' },
    );
    expect(markAllDenied).toMatchObject({
      isError: true,
      structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
    });
    expect(notificationService.markAllAsRead).not.toHaveBeenCalled();

    // 3. continuum_preview_departing_handover filters relatedProjects to allowedProjectIds
    handoverWorkflowService.previewDepartingMember.mockResolvedValueOnce({
      body: {
        departingUserId: USER_ID,
        projectId: PROJECT_ID,
        relatedProjects: [
          { projectId: PROJECT_ID, key: 'ALP', name: 'Alpha' },
          { projectId: FORBIDDEN_PROJECT_ID, key: 'BET', name: 'Beta Secret' },
        ],
        tasks: [],
        sources: [],
      },
    });
    const previewRes = await toolsService.callTool(
      scopedCtx,
      'continuum_preview_departing_handover',
      {
        projectId: PROJECT_ID,
        departingUserId: USER_ID,
      },
    );
    expect(previewRes).toMatchObject({
      structuredContent: {
        relatedProjects: [{ projectId: PROJECT_ID, key: 'ALP', name: 'Alpha' }],
      },
    });
  });

  it('enforces JSON-RPC 2.0 safe-integer/string Request IDs, rejects notifications carrying an id, and negotiates 2025-11-25 (BE-4)', async () => {
    const { mcpService } = createHarness();
    const ctx = {
      actor: orgWideFullActor,
      authorizationHeader: 'Bearer ctm_mcp_org',
    };

    // Valid edge IDs: 0 and ""
    for (const validId of [0, ''] as const) {
      const okRes = await mcpService.handlePayload(ctx, {
        jsonrpc: '2.0',
        id: validId,
        method: 'ping',
      });
      expect(okRes).toEqual({
        kind: 'response',
        protocolVersion: '2025-03-26',
        body: { jsonrpc: '2.0', id: validId, result: {} },
      });
    }

    // Invalid IDs: null, 1.5, true, {} -> -32600 with id: null
    for (const badId of [null, 1.5, true, {}]) {
      const errRes = await mcpService.handlePayload(ctx, {
        jsonrpc: '2.0',
        id: badId,
        method: 'ping',
      });
      expect(errRes).toMatchObject({
        kind: 'response',
        body: {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600 },
        },
      });
    }

    // Notification with id standalone -> -32600 (NOT 202 accepted)
    const notifWithId = await mcpService.handlePayload(ctx, {
      jsonrpc: '2.0',
      id: 99,
      method: 'notifications/initialized',
    });
    expect(notifWithId).toMatchObject({
      kind: 'response',
      body: {
        jsonrpc: '2.0',
        id: 99,
        error: { code: -32600 },
      },
    });

    // Notification with id inside batch -> returns 2 responses (ping + -32600 error)
    const batchNotifWithId = await mcpService.handlePayload(ctx, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 99, method: 'notifications/initialized' },
    ]);
    expect(batchNotifWithId.kind).toBe('response');
    if (batchNotifWithId.kind === 'response') {
      expect(batchNotifWithId.body).toEqual([
        { jsonrpc: '2.0', id: 1, result: {} },
        expect.objectContaining({
          jsonrpc: '2.0',
          error: expect.objectContaining({ code: -32600 }),
        }),
      ]);
    }

    // Supports 2025-11-25 protocol negotiation
    const initLatest = await mcpService.handlePayload(ctx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    });
    expect(initLatest).toMatchObject({
      kind: 'response',
      protocolVersion: '2025-11-25',
      body: {
        result: { protocolVersion: '2025-11-25' },
      },
    });
  });

  it('derives deterministic UUIDv4 handover idempotency keys, skips duplicate autoBundle on replay, and maps reviewNote on QUICK_ACCEPT (BE-5)', async () => {
    const { toolsService, handoverWorkflowService } = createHarness();
    const ctx = {
      actor: fullActor,
      authorizationHeader: 'Bearer ctm_mcp_full',
    };

    // 1. First call with custom string idempotencyKey derives deterministic UUIDv4s
    await toolsService.callTool(ctx, 'continuum_create_and_bundle_handover', {
      projectId: PROJECT_ID,
      departingUserId: USER_ID,
      assignedLeaderId: LEADER_ID,
      successorUserId: SUCCESSOR_ID,
      targetCompletionDate: '2026-12-31T00:00:00Z',
      title: 'Deterministic Handover',
      publishImmediately: true,
      idempotencyKey: 'custom-handover-idem-key-1',
    });
    const firstCalls = handoverWorkflowService.createHandover.mock
      .calls as Array<[string, unknown, { idempotencyKey: string }]>;
    const firstCreateKey = firstCalls[0][2].idempotencyKey;
    expect(firstCreateKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // 2. Replayed createHandover when getHandover already has publishedRevisionId skips autoBundleAndPublish
    handoverWorkflowService.createHandover.mockClear();
    handoverWorkflowService.autoBundleAndPublish.mockClear();
    handoverWorkflowService.createHandover.mockResolvedValueOnce({
      body: {
        operationId: firstCreateKey,
        handoverId: HANDOVER_ID,
        version: 1,
        status: 'OPEN',
        revisionId: null,
        replayed: true,
      },
      etag: `"handover:${HANDOVER_ID}:1"`,
      replayed: true,
    });
    handoverWorkflowService.getHandover.mockResolvedValueOnce({
      body: {
        handover: {
          id: HANDOVER_ID,
          version: 2,
          status: 'OPEN',
          publishedRevisionId: '651a2b3c4d5e6f7a8b9c0d44',
          assignmentVersion: 1,
        },
        publishedRevision: { id: '651a2b3c4d5e6f7a8b9c0d44', number: 1 },
        capabilities: ['READ'],
        requiredPendingCount: 0,
        canComplete: true,
      },
      etag: `"handover:${HANDOVER_ID}:2"`,
    });

    const replayRes = await toolsService.callTool(
      ctx,
      'continuum_create_and_bundle_handover',
      {
        projectId: PROJECT_ID,
        departingUserId: USER_ID,
        assignedLeaderId: LEADER_ID,
        successorUserId: SUCCESSOR_ID,
        targetCompletionDate: '2026-12-31T00:00:00Z',
        title: 'Deterministic Handover',
        publishImmediately: true,
        idempotencyKey: 'custom-handover-idem-key-1',
      },
    );
    const secondCalls = handoverWorkflowService.createHandover.mock
      .calls as Array<[string, unknown, { idempotencyKey: string }]>;
    const secondCreateKey = secondCalls[0][2].idempotencyKey;
    expect(secondCreateKey).toBe(firstCreateKey);
    expect(handoverWorkflowService.autoBundleAndPublish).not.toHaveBeenCalled();
    expect(replayRes).toMatchObject({
      structuredContent: {
        etag: `"handover:${HANDOVER_ID}:2"`,
      },
    });

    // 3. QUICK_ACCEPT accepts reviewNote when note is omitted
    await toolsService.callTool(ctx, 'continuum_act_on_handover', {
      projectId: PROJECT_ID,
      handoverId: HANDOVER_ID,
      action: 'QUICK_ACCEPT',
      reviewNote: 'Accepted all items cleanly.',
    });
    expect(handoverWorkflowService.quickAcceptHandover).toHaveBeenCalledWith(
      PROJECT_ID,
      HANDOVER_ID,
      { note: 'Accepted all items cleanly.' },
      expect.any(Object),
    );
  });

  it('guards against circular references, deeply nested payloads (depth 40 & 12000), prototype own-property, malformed patterns, and throwing getters without RangeError (V-01)', async () => {
    const { toolsService, taskWorkspaceService } = createHarness();
    const ctx = {
      actor: fullActor,
      authorizationHeader: 'Bearer ctm_mcp_full',
    };

    // 1. Rejects 'prototype' own-property on root and nested objects
    const prototypeRootRes = await toolsService.callTool(
      ctx,
      'continuum_get_context',
      { prototype: { polluted: true } },
    );
    expect(prototypeRootRes).toMatchObject({
      isError: true,
      structuredContent: { code: 'MCP_INVALID_ARGUMENTS' },
    });

    const prototypeNestedOutcome = validateMcpToolArguments(
      'custom_open_tool',
      { type: 'object' },
      { nested: { prototype: { injected: true } } },
    );
    expect(prototypeNestedOutcome).toMatchObject({
      ok: false,
      error: { code: 'MCP_INVALID_ARGUMENTS' },
    });

    // 2. Rejects circular references (circ.self = circ & circular arrays) without throwing RangeError
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    const circValidatorOutcome = validateMcpToolArguments(
      'custom_open_tool',
      { type: 'object' },
      circ,
    );
    expect(circValidatorOutcome).toMatchObject({
      ok: false,
      error: { code: 'MCP_INVALID_ARGUMENTS' },
    });

    const circSteps: unknown[] = [];
    circSteps.push(circSteps);
    const circToolRes = await toolsService.callTool(
      ctx,
      'continuum_create_task',
      {
        projectId: PROJECT_ID,
        title: 'Circular task steps',
        steps: circSteps,
      },
    );
    expect(circToolRes).toMatchObject({
      isError: true,
      structuredContent: { code: 'MCP_INVALID_ARGUMENTS' },
    });
    expect(taskWorkspaceService.createProjectTask).not.toHaveBeenCalled();

    // 3. Allows non-circular DAG shared object references
    const sharedStep = { text: 'Reusable checklist item', done: false };
    const dagRes = await toolsService.callTool(ctx, 'continuum_create_task', {
      projectId: PROJECT_ID,
      title: 'DAG shared steps',
      steps: [sharedStep, sharedStep],
    });
    expect(dagRes.isError).toBeFalsy();
    expect(taskWorkspaceService.createProjectTask).toHaveBeenCalledTimes(1);

    // 4. Rejects deeply-nested objects (depth = 40 and depth = 12000) cleanly without RangeError
    const buildDeepObject = (depth: number): Record<string, unknown> => {
      const root: Record<string, unknown> = {};
      let current = root;
      for (let i = 0; i < depth; i += 1) {
        const child: Record<string, unknown> = { label: 'nfd_e\u0301' };
        current.next = child;
        current = child;
      }
      return root;
    };

    for (const depth of [40, 12000]) {
      const deepPayload = buildDeepObject(depth);
      const outcome = validateMcpToolArguments(
        'deep_schema_tool',
        { type: 'object' },
        deepPayload,
      );
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'MCP_INVALID_ARGUMENTS' },
      });

      const deepArrayPayload: unknown[] = [];
      let arrCursor = deepArrayPayload;
      for (let i = 0; i < depth; i += 1) {
        const nextArr: unknown[] = [];
        arrCursor.push(nextArr);
        arrCursor = nextArr;
      }
      const callOutcome = await toolsService.callTool(
        ctx,
        'continuum_create_task',
        {
          projectId: PROJECT_ID,
          title: `Deep ${depth}`,
          steps: deepArrayPayload,
        },
      );
      expect(callOutcome).toMatchObject({
        isError: true,
        structuredContent: { code: 'MCP_INVALID_ARGUMENTS' },
      });
    }

    // 5. Guards invalid schema.pattern without throwing SyntaxError
    const badRegexOutcome = validateMcpToolArguments(
      'malformed_pattern_tool',
      {
        type: 'object',
        properties: {
          token: { type: 'string', pattern: '[unclosed(' },
        },
      },
      { token: 'abc' },
    );
    expect(badRegexOutcome).toMatchObject({
      ok: false,
      error: { code: 'MCP_INVALID_ARGUMENTS', field: 'token' },
    });

    // 6. Wraps validateMcpToolArguments inside callTool try/catch so throwing getters return MCP error
    const hostileArgs: Record<string, unknown> = {};
    Object.defineProperty(hostileArgs, 'projectId', {
      enumerable: true,
      get() {
        throw new Error('Hostile getter explosion');
      },
    });
    const hostileRes = await toolsService.callTool(
      ctx,
      'continuum_get_project',
      hostileArgs,
    );
    expect(hostileRes).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'INTERNAL_TOOL_ERROR',
        message: 'Hostile getter explosion',
      },
    });
  });

  it('logs Logger.warn with degraded telemetry on operational errors in readResource while rethrowing auth/ACL exceptions (V-03)', async () => {
    const { toolsService, taskWorkspaceService } = createHarness();
    const ctx = {
      actor: fullActor,
      authorizationHeader: 'Bearer ctm_mcp_full',
    };
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      // 1. Healthy overview includes degraded: false and omits degradedFields
      const healthyRes = await toolsService.readResource(
        ctx,
        `continuum://projects/${PROJECT_ID}/overview`,
      );
      const healthyPayload = JSON.parse(healthyRes.contents[0].text) as Record<
        string,
        unknown
      >;
      expect(healthyPayload.degraded).toBe(false);
      expect(healthyPayload.degradedFields).toBeUndefined();

      // 2. Operational error on getProjectTaskSummary -> logs warn + degraded: true + degradedFields: ['taskSummary']
      taskWorkspaceService.getProjectTaskSummary.mockRejectedValueOnce(
        new Error('Upstream task DB timeout'),
      );
      const degradedRes = await toolsService.readResource(
        ctx,
        `continuum://projects/${PROJECT_ID}/overview`,
      );
      const degradedPayload = JSON.parse(
        degradedRes.contents[0].text,
      ) as Record<string, unknown>;
      expect(degradedPayload).toMatchObject({
        taskSummary: null,
        degraded: true,
        degradedFields: ['taskSummary'],
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(PROJECT_ID));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Upstream task DB timeout'),
      );

      // 3. Auth/ACL exceptions (UnauthorizedException, ForbiddenException, NotFoundException) are rethrown
      for (const aclError of [
        new UnauthorizedException('Expired token'),
        new ForbiddenException('ACL denied'),
        new NotFoundException('Project missing'),
      ]) {
        taskWorkspaceService.getProjectTaskSummary.mockRejectedValueOnce(
          aclError,
        );
        await expect(
          toolsService.readResource(
            ctx,
            `continuum://projects/${PROJECT_ID}/overview`,
          ),
        ).rejects.toThrow(aclError);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('escalates continuum_ask_knowledge to READ_WRITE when persistThread=true creates a new thread and forwards persistThread', async () => {
    const { toolsService, aiChatService } = createHarness();
    const readOnlyActor: AuthenticatedIdentity = {
      ...fullActor,
      mcpGrant: {
        keyId: '651a2b3c4d5e6f7a8b9c0d98',
        scope: 'READ_ONLY',
        allowedProjectIds: [PROJECT_ID],
      },
    };
    const readWriteActor: AuthenticatedIdentity = {
      ...fullActor,
      mcpGrant: {
        keyId: '651a2b3c4d5e6f7a8b9c0d97',
        scope: 'READ_WRITE',
        allowedProjectIds: [PROJECT_ID],
      },
    };

    const rejected = await toolsService.callTool(
      { actor: readOnlyActor, authorizationHeader: 'Bearer ctm_mcp_ro' },
      'continuum_ask_knowledge',
      {
        projectId: PROJECT_ID,
        query: 'Create persistent AI thread?',
        persistThread: true,
      },
    );
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'MCP_SCOPE_FORBIDDEN',
      },
    });
    expect(aiChatService.askKnowledgeQuestion).not.toHaveBeenCalled();

    aiChatService.askKnowledgeQuestion.mockResolvedValueOnce({
      threadId: 'thread_kept_1',
      threadPersisted: true,
      messageId: 'msg_2',
      answer: 'Persisted grounded answer [1].',
      answerStatus: 'answered',
      citations: [],
      retrievalSteps: [],
    });

    const allowed = await toolsService.callTool(
      { actor: readWriteActor, authorizationHeader: 'Bearer ctm_mcp_rw' },
      'continuum_ask_knowledge',
      {
        projectId: PROJECT_ID,
        query: 'Create persistent AI thread?',
        persistThread: true,
      },
    );
    expect(allowed.isError).toBeUndefined();
    expect(allowed.structuredContent).toMatchObject({
      threadId: 'thread_kept_1',
      threadPersisted: true,
    });
    expect(aiChatService.askKnowledgeQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: 'Bearer ctm_mcp_rw',
        organizationId: ORG_ID,
      }),
      {
        projectId: PROJECT_ID,
        query: 'Create persistent AI thread?',
        persistThread: true,
      },
    );
  });

  it('supports project/member lifecycle, binary document upload, document/work-note/work-report review, and live RBAC denial', async () => {
    const {
      toolsService,
      projectService,
      projectAccessService,
      workNotesService,
      authorizationPolicy,
    } = createHarness();
    const orgCtx = {
      actor: orgWideFullActor,
      authorizationHeader: 'Bearer ctm_mcp_org_full',
    };
    const scopedCtx = {
      actor: fullActor,
      authorizationHeader: 'Bearer ctm_mcp_scoped_full',
    };

    // 1. Project-restricted key is blocked on continuum_create_project
    const restrictedCreate = await toolsService.callTool(
      scopedCtx,
      'continuum_create_project',
      { name: 'Blocked Project', code: 'BLK' },
    );
    expect(restrictedCreate).toMatchObject({
      isError: true,
      structuredContent: { code: 'MCP_SCOPE_FORBIDDEN' },
    });

    // 2. Live RBAC denial on continuum_create_project
    authorizationPolicy.evaluate.mockReturnValueOnce({ allowed: false });
    const rbacDeniedCreate = await toolsService.callTool(
      orgCtx,
      'continuum_create_project',
      { name: 'Unauthorized Project', code: 'UNAUTH' },
    );
    expect(rbacDeniedCreate).toMatchObject({
      isError: true,
      structuredContent: { status: 403, code: 'FORBIDDEN' },
    });
    expect(projectService.create).not.toHaveBeenCalled();

    // 3. Successful create, update, and member/leader management
    const createdProj = await toolsService.callTool(
      orgCtx,
      'continuum_create_project',
      {
        name: 'Continuum Core',
        code: 'CNTM',
        visibility: 'PRIVATE',
        memberUserIds: [SUCCESSOR_ID, SUCCESSOR_ID],
      },
    );
    expect(createdProj.isError).toBeUndefined();
    expect(projectService.create).toHaveBeenCalledWith(
      orgWideFullActor,
      expect.objectContaining({
        name: 'Continuum Core',
        code: 'CNTM',
        visibility: 'PRIVATE',
        memberUserIds: [SUCCESSOR_ID],
      }),
    );

    const updatedProj = await toolsService.callTool(
      orgCtx,
      'continuum_update_project',
      { projectId: PROJECT_ID, name: 'Alpha Renamed', visibility: 'PUBLIC' },
    );
    expect(updatedProj.isError).toBeUndefined();
    expect(projectAccessService.updateSettings).toHaveBeenCalledWith(
      orgWideFullActor,
      PROJECT_ID,
      { name: 'Alpha Renamed' },
    );
    expect(projectAccessService.changeVisibility).toHaveBeenCalledWith(
      orgWideFullActor,
      PROJECT_ID,
      'PUBLIC',
    );

    authorizationPolicy.evaluateProjectAccess.mockReturnValueOnce({
      allowed: false,
    });
    const deniedAdd = await toolsService.callTool(
      orgCtx,
      'continuum_manage_project_members',
      { projectId: PROJECT_ID, action: 'ADD_MEMBER', userId: SUCCESSOR_ID },
    );
    expect(deniedAdd).toMatchObject({
      isError: true,
      structuredContent: { status: 403, code: 'FORBIDDEN' },
    });

    const addedMember = await toolsService.callTool(
      orgCtx,
      'continuum_manage_project_members',
      {
        projectId: PROJECT_ID,
        action: 'ADD_MEMBER',
        userId: SUCCESSOR_ID,
        role: 'MEMBER',
      },
    );
    expect(addedMember.isError).toBeUndefined();
    expect(projectAccessService.addMember).toHaveBeenCalledWith(
      orgWideFullActor,
      PROJECT_ID,
      SUCCESSOR_ID,
      'MEMBER',
    );

    // 4. Document get + base64 file upload validation + review/SAG sync
    const gotDoc = await toolsService.callTool(
      orgCtx,
      'continuum_get_document',
      { projectId: PROJECT_ID, documentId: '651a2b3c4d5e6f7a8b9c0d66' },
    );
    expect(gotDoc.structuredContent).toMatchObject({
      id: '651a2b3c4d5e6f7a8b9c0d66',
      knowledgeStatus: { knowledgeReady: true },
    });

    const badBase64 = await toolsService.callTool(
      orgCtx,
      'continuum_upload_document_file',
      {
        projectId: PROJECT_ID,
        documentId: '651a2b3c4d5e6f7a8b9c0d66',
        fileName: 'spec.md',
        contentType: 'text/markdown',
        contentBase64: '***not-base64***',
      },
    );
    expect(badBase64).toMatchObject({
      isError: true,
      structuredContent: { code: 'DOCUMENT_FILE_INVALID' },
    });

    const uploadedDoc = await toolsService.callTool(
      orgCtx,
      'continuum_upload_document_file',
      {
        projectId: PROJECT_ID,
        documentId: '651a2b3c4d5e6f7a8b9c0d66',
        fileName: 'spec.md',
        contentType: 'text/markdown',
        contentBase64: Buffer.from('# Spec v1').toString('base64'),
      },
    );
    expect(uploadedDoc.isError).toBeUndefined();
    expect(workNotesService.uploadDocumentFile).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID }),
      PROJECT_ID,
      '651a2b3c4d5e6f7a8b9c0d66',
      'spec.md',
      'text/markdown',
      Buffer.from('# Spec v1'),
    );

    const rejectedWithoutComment = await toolsService.callTool(
      orgCtx,
      'continuum_review_document',
      {
        projectId: PROJECT_ID,
        documentId: '651a2b3c4d5e6f7a8b9c0d66',
        action: 'REJECT',
      },
    );
    expect(rejectedWithoutComment).toMatchObject({
      isError: true,
      structuredContent: { code: 'VALIDATION_FAILED' },
    });

    const approvedDoc = await toolsService.callTool(
      orgCtx,
      'continuum_review_document',
      {
        projectId: PROJECT_ID,
        documentId: '651a2b3c4d5e6f7a8b9c0d66',
        action: 'APPROVE',
        comment: 'Verified architecture',
      },
    );
    expect(approvedDoc.isError).toBeUndefined();
    expect(workNotesService.reviewDocument).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID }),
      PROJECT_ID,
      '651a2b3c4d5e6f7a8b9c0d66',
      'APPROVED',
      { comment: 'Verified architecture' },
    );

    const syncedDoc = await toolsService.callTool(
      orgCtx,
      'continuum_review_document',
      {
        projectId: PROJECT_ID,
        documentId: '651a2b3c4d5e6f7a8b9c0d66',
        action: 'SYNC_KNOWLEDGE',
      },
    );
    expect(syncedDoc.isError).toBeUndefined();
    expect(workNotesService.syncDocumentToSag).toHaveBeenCalled();

    // 5. Work note & work report reviews require comment on REJECT/REQUEST_CHANGES and map statuses cleanly
    const noteChangesMissingComment = await toolsService.callTool(
      orgCtx,
      'continuum_review_work_note',
      { projectId: PROJECT_ID, noteId: NOTE_ID, action: 'REQUEST_CHANGES' },
    );
    expect(noteChangesMissingComment).toMatchObject({
      isError: true,
      structuredContent: { code: 'VALIDATION_FAILED' },
    });

    const noteApproved = await toolsService.callTool(
      orgCtx,
      'continuum_review_work_note',
      {
        projectId: PROJECT_ID,
        noteId: NOTE_ID,
        action: 'APPROVE',
        comment: 'Looks solid',
      },
    );
    expect(noteApproved.isError).toBeUndefined();
    expect(workNotesService.reviewTaskNote).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID }),
      PROJECT_ID,
      NOTE_ID,
      'APPROVED',
      { comment: 'Looks solid' },
    );

    const reportApproved = await toolsService.callTool(
      orgCtx,
      'continuum_review_work_report',
      {
        projectId: PROJECT_ID,
        reportId: '651a2b3c4d5e6f7a8b9c0d55',
        action: 'APPROVE',
      },
    );
    expect(reportApproved.isError).toBeUndefined();
    expect(workNotesService.reviewWorkReport).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID }),
      PROJECT_ID,
      '651a2b3c4d5e6f7a8b9c0d55',
      'APPROVED',
      {},
    );
  });
});
