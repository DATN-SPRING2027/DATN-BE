import type {
  McpPromptDefinition,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpToolDefinition,
} from './mcp.types';

const OBJECT_ID_SCHEMA = {
  type: 'string',
  pattern: '^[a-fA-F0-9]{24}$',
  description: '24-character hexadecimal Continuum identifier.',
} as const;

export const MCP_RESOURCES_CATALOG: readonly McpResourceDefinition[] = [
  {
    uri: 'continuum://context/current',
    name: 'Current Continuum Context',
    description:
      'Authenticated user profile, active organization roles, MCP API key grant scope, and accessible active projects.',
    mimeType: 'application/json',
  },
];

export const MCP_RESOURCE_TEMPLATES_CATALOG: readonly McpResourceTemplateDefinition[] =
  [
    {
      uriTemplate: 'continuum://projects/{projectId}/overview',
      name: 'Project Operational Overview',
      description:
        'Live project metadata, leadership roster, task status breakdown, and sprint summary for a Continuum project.',
      mimeType: 'application/json',
    },
  ];

export const MCP_PROMPTS_CATALOG: readonly McpPromptDefinition[] = [
  {
    name: 'daily-standup-brief',
    description:
      'Synthesize a concise daily standup brief from active project tasks, recent work notes, and blockers.',
    arguments: [
      {
        name: 'projectId',
        description: '24-character hex project ID to summarize.',
        required: true,
      },
    ],
  },
  {
    name: 'handover-readiness-audit',
    description:
      'Audit knowledge handover readiness, unfinished tasks, and documentation coverage for a project or departing member.',
    arguments: [
      {
        name: 'projectId',
        description: '24-character hex project ID.',
        required: true,
      },
      {
        name: 'departingUserId',
        description:
          'Optional 24-character hex user ID of the departing member to preview.',
        required: false,
      },
    ],
  },
  {
    name: 'task-triage-assistant',
    description:
      'Inspect backlog, blocked, and overdue tasks in a project and recommend prioritization and assignments.',
    arguments: [
      {
        name: 'projectId',
        description: '24-character hex project ID.',
        required: true,
      },
    ],
  },
  {
    name: 'project-onboarding-pack',
    description:
      'Generate a grounded onboarding briefing for a new engineer joining a Continuum project using SAG knowledge and active sprints.',
    arguments: [
      {
        name: 'projectId',
        description: '24-character hex project ID.',
        required: true,
      },
    ],
  },
];

export const MCP_TOOLS_CATALOG: readonly McpToolDefinition[] = [
  // =========================================================================
  // 1. IAM & Projects (4)
  // =========================================================================
  {
    name: 'continuum_get_context',
    description:
      'Return the authenticated Continuum actor, active organization ID, roles, and MCP API key scope grant.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Get Current Continuum Context',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_list_projects',
    description:
      'List projects visible to the authenticated user in the current organization (filtered to allowedProjectIds if scoped).',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'List Accessible Projects',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] },
        q: {
          type: 'string',
          maxLength: 120,
          description: 'Optional search term matching project name or code.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_get_project',
    description: 'Fetch detailed metadata for a single Continuum project.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Get Project Details',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_list_project_members',
    description:
      'List project members and designated project leaders for an accessible project.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'List Project Members & Leaders',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        page: { type: 'integer', minimum: 1, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        status: {
          type: 'string',
          enum: ['ACTIVE', 'INACTIVE'],
          default: 'ACTIVE',
        },
        search: { type: 'string', maxLength: 120 },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },

  // =========================================================================
  // 2. Tasks & Sprints (8)
  // =========================================================================
  {
    name: 'continuum_list_tasks',
    description:
      'List tasks in a project with optional filters for status, priority, type, assignee, sprint, parent task, due dates, and text search.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'List Project Tasks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        afterId: OBJECT_ID_SCHEMA,
        cursor: { type: 'string', maxLength: 512 },
        status: {
          type: 'string',
          description:
            'Single or comma-separated statuses: TODO, IN_PROGRESS, IN_REVIEW, BLOCKED, DONE, CANCELLED.',
        },
        priority: {
          type: 'string',
          description:
            'Single or comma-separated priorities: LOW, MEDIUM, HIGH.',
        },
        type: {
          type: 'string',
          description: 'Single or comma-separated types: TASK, BUG, STORY.',
        },
        assigneeId: {
          type: 'string',
          pattern: '^(?:me|none|unassigned|[a-fA-F0-9]{24})$',
          description: '24-hex user ID, "me", "none", or "unassigned".',
        },
        parentId: {
          type: 'string',
          description: '24-hex parent task ID or "none" for top-level tasks.',
        },
        sprintId: {
          type: 'string',
          pattern: '^(?:none|backlog|[a-fA-F0-9]{24})$',
          description: '24-hex sprint ID, "none", or "backlog".',
        },
        dueFrom: {
          type: 'string',
          description: 'ISO-8601 date-time lower bound.',
        },
        dueTo: {
          type: 'string',
          description: 'ISO-8601 date-time upper bound.',
        },
        q: { type: 'string', minLength: 2, maxLength: 100 },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_get_task',
    description:
      'Retrieve full details, checklist steps, ETag, and optional comments/history for a single task.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Get Task Details',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        taskId: OBJECT_ID_SCHEMA,
        includeComments: { type: 'boolean', default: false },
        includeHistory: { type: 'boolean', default: false },
      },
      required: ['projectId', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_get_project_task_summary',
    description:
      'Get aggregated task counts by status, priority, overdue state, and assignee workload for a project.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Get Project Task Summary',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_list_sprints',
    description: 'List sprints and sprint task counters for a project.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'List Project Sprints',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        status: {
          type: 'string',
          enum: ['PLANNED', 'ACTIVE', 'COMPLETED'],
        },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_create_task',
    description:
      'Create a new task, bug, story, or subtask inside a Continuum project.',
    requiredScope: 'READ_WRITE',
    annotations: {
      title: 'Create Project Task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        title: { type: 'string', minLength: 1, maxLength: 255 },
        description: { type: ['string', 'null'], maxLength: 20000 },
        type: {
          type: 'string',
          enum: ['TASK', 'BUG', 'STORY'],
          default: 'TASK',
        },
        priority: {
          type: 'string',
          enum: ['LOW', 'MEDIUM', 'HIGH'],
          default: 'MEDIUM',
        },
        assigneeId: {
          oneOf: [OBJECT_ID_SCHEMA, { type: 'null' }],
        },
        parentId: {
          oneOf: [OBJECT_ID_SCHEMA, { type: 'null' }],
        },
        sprintId: {
          oneOf: [OBJECT_ID_SCHEMA, { type: 'null' }],
        },
        dueDate: { type: ['string', 'null'] },
        startDate: { type: ['string', 'null'] },
        labels: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 40 },
        },
        steps: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 64 },
              text: { type: 'string', minLength: 1, maxLength: 500 },
              done: { type: 'boolean' },
            },
            required: ['text', 'done'],
            additionalProperties: false,
          },
        },
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['projectId', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_update_task',
    description:
      'Update mutable task fields (title, description, priority, assigneeId, sprintId, dates, labels, steps). Automatically resolves current ETag when ifMatch is omitted.',
    requiredScope: 'READ_WRITE',
    annotations: {
      title: 'Update Project Task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        taskId: OBJECT_ID_SCHEMA,
        ifMatch: {
          type: 'string',
          description:
            'Optional strong ETag ("task:<id>:<version>"). Fetched automatically when omitted.',
        },
        title: { type: 'string', minLength: 1, maxLength: 255 },
        description: { type: ['string', 'null'], maxLength: 20000 },
        type: { type: 'string', enum: ['TASK', 'BUG', 'STORY'] },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        assigneeId: { oneOf: [OBJECT_ID_SCHEMA, { type: 'null' }] },
        parentId: { oneOf: [OBJECT_ID_SCHEMA, { type: 'null' }] },
        sprintId: { oneOf: [OBJECT_ID_SCHEMA, { type: 'null' }] },
        dueDate: { type: ['string', 'null'] },
        startDate: { type: ['string', 'null'] },
        labels: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 40 },
        },
        steps: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 64 },
              text: { type: 'string', minLength: 1, maxLength: 500 },
              done: { type: 'boolean' },
            },
            required: ['text', 'done'],
            additionalProperties: false,
          },
        },
      },
      required: ['projectId', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_transition_task',
    description:
      'Transition a task to a new workflow status (TODO, IN_PROGRESS, IN_REVIEW, BLOCKED, DONE, CANCELLED). Automatically resolves ETag if ifMatch is omitted.',
    requiredScope: 'READ_WRITE',
    annotations: {
      title: 'Transition Task Status',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        taskId: OBJECT_ID_SCHEMA,
        toStatus: {
          type: 'string',
          enum: [
            'TODO',
            'IN_PROGRESS',
            'IN_REVIEW',
            'BLOCKED',
            'DONE',
            'CANCELLED',
          ],
        },
        fromStatus: {
          type: 'string',
          enum: [
            'TODO',
            'IN_PROGRESS',
            'IN_REVIEW',
            'BLOCKED',
            'DONE',
            'CANCELLED',
          ],
        },
        reason: {
          type: 'string',
          maxLength: 500,
          description:
            'Required (min 5 chars) when transitioning to BLOCKED or CANCELLED or reopening from DONE.',
        },
        ifMatch: { type: 'string' },
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['projectId', 'taskId', 'toStatus'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_add_task_comment',
    description: 'Post a comment on a project task.',
    requiredScope: 'READ_WRITE',
    annotations: {
      title: 'Add Task Comment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        taskId: OBJECT_ID_SCHEMA,
        body: { type: 'string', minLength: 1, maxLength: 5000 },
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['projectId', 'taskId', 'body'],
      additionalProperties: false,
    },
  },

  // =========================================================================
  // 3. Work Notes, Documents & Reports (7)
  // =========================================================================
  {
    name: 'continuum_list_work_notes',
    description:
      'List structured engineering work notes across a project or specific task.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'List Work Notes',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        taskId: OBJECT_ID_SCHEMA,
        authorId: OBJECT_ID_SCHEMA,
        reviewStatus: {
          type: 'string',
          enum: ['PENDING_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED'],
        },
        search: { type: 'string', maxLength: 200 },
        sort: { type: 'string', enum: ['recent', 'oldest'], default: 'recent' },
        page: { type: 'integer', minimum: 1, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_get_work_note',
    description: 'Fetch a single task work note and its SAG sync/review state.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Get Work Note',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        noteId: OBJECT_ID_SCHEMA,
        taskId: OBJECT_ID_SCHEMA,
      },
      required: ['projectId', 'noteId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_create_work_note',
    description:
      'Capture a structured task work note (accomplishments, approach, engineering rationale) linked to a task.',
    requiredScope: 'READ_WRITE',
    annotations: {
      title: 'Create Task Work Note',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        taskId: OBJECT_ID_SCHEMA,
        title: { type: 'string', minLength: 1, maxLength: 200 },
        accomplishments: { type: 'string', minLength: 1, maxLength: 10000 },
        approach: { type: 'string', minLength: 1, maxLength: 10000 },
        reason: { type: 'string', minLength: 1, maxLength: 10000 },
        autoApprove: { type: 'boolean' },
      },
      required: [
        'projectId',
        'taskId',
        'title',
        'accomplishments',
        'approach',
        'reason',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_list_documents',
    description:
      'List project documents and their governance/knowledge status.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'List Project Documents',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        page: { type: 'integer', minimum: 1, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        status: {
          type: 'string',
          enum: [
            'DRAFT',
            'PENDING_REVIEW',
            'APPROVED',
            'CHANGES_REQUESTED',
            'REJECTED',
            'ARCHIVED',
          ],
        },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_create_document',
    description:
      'Create a Markdown/text project document (and optionally submit it for review). Requires FULL_OPERATIONS scope.',
    requiredScope: 'FULL_OPERATIONS',
    annotations: {
      title: 'Create Project Document',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 2000 },
        type: {
          type: 'string',
          enum: [
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
          ],
        },
        content: { type: 'string', minLength: 1, maxLength: 100000 },
        submitForReview: { type: 'boolean', default: false },
      },
      required: ['projectId', 'title', 'type', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_list_work_reports',
    description: 'List periodic member or leader work reports in a project.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'List Work Reports',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        page: { type: 'integer', minimum: 1, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        status: {
          type: 'string',
          enum: [
            'DRAFT',
            'PENDING_REVIEW',
            'APPROVED',
            'CHANGES_REQUESTED',
            'REJECTED',
            'OVERDUE',
          ],
        },
        scope: {
          type: 'string',
          enum: ['MEMBER', 'LEADER'],
          default: 'MEMBER',
        },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_save_work_report_draft',
    description:
      'Save the current or specified work report draft (READ_WRITE), and optionally submit it for review when submit=true (requires FULL_OPERATIONS).',
    requiredScope: 'READ_WRITE',
    annotations: {
      title: 'Save or Submit Work Report',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        reportId: OBJECT_ID_SCHEMA,
        scope: {
          type: 'string',
          enum: ['MEMBER', 'LEADER'],
          default: 'MEMBER',
        },
        accomplishments: { type: 'string', minLength: 1, maxLength: 10000 },
        approach: { type: 'string', minLength: 1, maxLength: 10000 },
        reason: { type: 'string', minLength: 1, maxLength: 10000 },
        blockers: { type: 'string', maxLength: 5000 },
        nextSteps: { type: 'string', maxLength: 5000 },
        documentIds: {
          type: 'array',
          maxItems: 20,
          items: OBJECT_ID_SCHEMA,
        },
        submit: {
          type: 'boolean',
          default: false,
          description:
            'When true, immediately submits the saved draft for review (requires FULL_OPERATIONS scope).',
        },
      },
      required: ['projectId', 'accomplishments', 'approach', 'reason'],
      additionalProperties: false,
    },
  },

  // =========================================================================
  // 4. Knowledge Handover (5)
  // =========================================================================
  {
    name: 'continuum_list_handovers',
    description: 'List knowledge handover packages in a project.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'List Project Handovers',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        participantRole: {
          type: 'string',
          enum: ['DEPARTING', 'SUCCESSOR'],
        },
        cursor: { type: 'string', maxLength: 512 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_get_handover',
    description:
      'Fetch full details, published revision items, readiness status, capabilities, and ETag of a handover package.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Get Handover Package',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        handoverId: OBJECT_ID_SCHEMA,
      },
      required: ['projectId', 'handoverId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_preview_departing_handover',
    description:
      'Preview unfinished tasks and eligible knowledge sources (work notes, documents, reports) of a departing project member.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Preview Departing Member Handover Scope',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        departingUserId: OBJECT_ID_SCHEMA,
        handoverId: OBJECT_ID_SCHEMA,
      },
      required: ['projectId', 'departingUserId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_create_and_bundle_handover',
    description:
      'Create a project knowledge handover package (with teamId=null) and optionally auto-bundle & publish tasks and knowledge sources.',
    requiredScope: 'FULL_OPERATIONS',
    annotations: {
      title: 'Create & Bundle Handover',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        departingUserId: OBJECT_ID_SCHEMA,
        assignedLeaderId: OBJECT_ID_SCHEMA,
        successorUserId: {
          oneOf: [OBJECT_ID_SCHEMA, { type: 'null' }],
        },
        targetCompletionDate: {
          type: 'string',
          description: 'ISO-8601 target completion date-time.',
        },
        title: { type: 'string', minLength: 1, maxLength: 255 },
        taskIds: {
          type: 'array',
          maxItems: 100,
          items: OBJECT_ID_SCHEMA,
        },
        selectedSources: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'TASK_NOTE',
                  'PROJECT_DOCUMENT',
                  'WORK_REPORT',
                  'KNOWLEDGE_OBJECT',
                ],
              },
              id: { type: 'string', minLength: 1, maxLength: 200 },
              version: { type: 'string', minLength: 1, maxLength: 200 },
            },
            required: ['kind', 'id', 'version'],
            additionalProperties: false,
          },
        },
        publishImmediately: { type: 'boolean', default: false },
        idempotencyKey: { type: 'string', maxLength: 64 },
      },
      required: [
        'projectId',
        'departingUserId',
        'assignedLeaderId',
        'targetCompletionDate',
        'title',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_act_on_handover',
    description:
      'Execute a lifecycle operation on an existing handover (AUTO_BUNDLE, QUICK_TRANSFER_TASKS, QUICK_ACCEPT, COMPLETE, CANCEL). Automatically resolves ETag when ifMatch is omitted.',
    requiredScope: 'FULL_OPERATIONS',
    annotations: {
      title: 'Act on Handover Package',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        handoverId: OBJECT_ID_SCHEMA,
        action: {
          type: 'string',
          enum: [
            'AUTO_BUNDLE',
            'QUICK_TRANSFER_TASKS',
            'QUICK_ACCEPT',
            'COMPLETE',
            'CANCEL',
          ],
        },
        ifMatch: { type: 'string' },
        idempotencyKey: { type: 'string', maxLength: 64 },
        taskIds: {
          type: 'array',
          maxItems: 100,
          items: OBJECT_ID_SCHEMA,
        },
        selectedSources: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'TASK_NOTE',
                  'PROJECT_DOCUMENT',
                  'WORK_REPORT',
                  'KNOWLEDGE_OBJECT',
                ],
              },
              id: { type: 'string', minLength: 1, maxLength: 200 },
              version: { type: 'string', minLength: 1, maxLength: 200 },
            },
            required: ['kind', 'id', 'version'],
            additionalProperties: false,
          },
        },
        note: { type: 'string', maxLength: 2000 },
        reviewNote: { type: 'string', maxLength: 2000 },
        reason: { type: 'string', maxLength: 2000 },
        revisionId: OBJECT_ID_SCHEMA,
        assignmentVersion: { type: 'integer', minimum: 1 },
      },
      required: ['projectId', 'handoverId', 'action'],
      additionalProperties: false,
    },
  },

  // =========================================================================
  // 5. SAG Knowledge & Grounded AI Q&A (2)
  // =========================================================================
  {
    name: 'continuum_search_knowledge',
    description:
      'Run hybrid RRF semantic + lexical search over approved project knowledge in SAG and return ranked sections, citations, and grounded summary.',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Search Project Knowledge (SAG)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        query: { type: 'string', minLength: 1, maxLength: 4000 },
        topK: { type: 'integer', minimum: 1, maximum: 50 },
        retrievalMode: {
          type: 'string',
          enum: [
            'EXACT',
            'LOCAL_FACTUAL',
            'ENTITY_RELATIONAL',
            'TEMPORAL',
            'GLOBAL_TOPIC',
            'MULTI_HOP',
          ],
        },
        sourceIds: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
      required: ['projectId', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_ask_knowledge',
    description:
      'Ask a multi-turn grounded question to the Continuum SAG AI agent for a project, returning cited answers and retrieval steps. Pass persistThread=true when omitting threadId to persist the new thread for follow-up turns (requires READ_WRITE scope).',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Ask Grounded Knowledge AI',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectId: OBJECT_ID_SCHEMA,
        query: { type: 'string', minLength: 1, maxLength: 4000 },
        threadId: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]{1,64}$',
          description:
            'Optional existing AI chat thread ID to continue a multi-turn conversation.',
        },
        persistThread: {
          type: 'boolean',
          default: false,
          description:
            'When true and threadId is omitted, persists the newly created SAG AI thread so the returned threadId can be reused in follow-up calls (requires READ_WRITE scope).',
        },
      },
      required: ['projectId', 'query'],
      additionalProperties: false,
    },
  },

  // =========================================================================
  // 6. Human Chat & Notifications (2)
  // =========================================================================
  {
    name: 'continuum_chat',
    description:
      'List conversations, read message history, search messages (READ_ONLY), or send a human chat message (SEND_MESSAGE requires FULL_OPERATIONS).',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Continuum Team Chat',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'LIST_CONVERSATIONS',
            'LIST_MESSAGES',
            'SEARCH_MESSAGES',
            'SEND_MESSAGE',
          ],
        },
        conversationId: OBJECT_ID_SCHEMA,
        search: { type: 'string', maxLength: 80 },
        query: { type: 'string', minLength: 2, maxLength: 80 },
        content: { type: 'string', minLength: 1, maxLength: 8000 },
        replyToMessageId: OBJECT_ID_SCHEMA,
        mentionUserIds: {
          type: 'array',
          maxItems: 50,
          items: OBJECT_ID_SCHEMA,
        },
        cursor: { type: 'string', maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        archived: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'continuum_notifications',
    description:
      'List notifications or unread count (READ_ONLY), or mark notifications as read (MARK_READ / MARK_ALL_READ requires READ_WRITE).',
    requiredScope: 'READ_ONLY',
    annotations: {
      title: 'Continuum Notifications',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['LIST', 'UNREAD_COUNT', 'MARK_READ', 'MARK_ALL_READ'],
        },
        notificationId: OBJECT_ID_SCHEMA,
        unreadOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: { type: 'string', maxLength: 256 },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];
