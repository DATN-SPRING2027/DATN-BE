import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  INestApplication,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Types, type Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { AUDIT_DATABASE_NAME } from '../src/common/mongodb/database-names';
import {
  AI_ENGINE_CLIENT,
  type AiEngineClient,
  type AiEngineRequest,
  type AiEngineResponse,
} from '../src/integrations/ai-engine/ai-engine.port';
import { HandoverCaptureSourceService } from '../src/services/capture/application/handover-capture-source.service';
import { CAPTURE_PERSISTENCE } from '../src/services/capture/infrastructure/persistence';
import { HandoverAiService } from '../src/services/handover/application/handover-ai.service';
import { HandoverRepository } from '../src/services/handover/application/handover.repository';
import { HandoverSourcesService } from '../src/services/handover/application/handover-sources.service';
import { HandoverTransferService } from '../src/services/handover/application/handover-transfer.service';
import { HandoverWorkflowService } from '../src/services/handover/application/handover-workflow.service';
import { HandoverWorkflowController } from '../src/services/handover/controllers/handover-workflow.controller';
import { AuditService } from '../src/services/handover/infrastructure/audit/audit.service';
import { OutboxService } from '../src/services/handover/infrastructure/outbox/outbox.service';
import { HANDOVER_PERSISTENCE } from '../src/services/handover/infrastructure/persistence';
import {
  AuthenticationApplicationService,
  readCookie,
  type AuthenticatedIdentity,
} from '../src/services/iam/application/authentication/authentication.application.service';
import { HandoverIamScopeService } from '../src/services/iam/application/projects/handover-iam-scope.service';
import { IAM_PERSISTENCE } from '../src/services/iam/infrastructure/persistence';
import { HandoverLifecycleSourceService } from '../src/services/lifecycle/application/handover-lifecycle-source.service';
import { LIFECYCLE_PERSISTENCE } from '../src/services/lifecycle/infrastructure/persistence';
import { HandoverTaskAssignmentService } from '../src/services/task/workspace/handover-task-assignment.service';
import {
  TASK_WORKSPACE_REPOSITORY,
  TaskWorkspaceRepository,
} from '../src/services/task/workspace/task-workspace.repository';
import {
  WORKSPACE_COLLECTION_VALIDATORS,
  WORKSPACE_INDEX_CATALOGUE,
  WORKSPACE_TASKS_COLLECTION,
  WORKSPACE_TASK_DATABASE_NAME,
} from '../src/services/task/workspace/task-workspace.types';

jest.setTimeout(180_000);

interface MigrationReport {
  applied?: boolean;
  reportSha256: string;
  blockers: Array<{ collection: string; code: string; count?: number }>;
  collections: Array<{ name: string; action: string }>;
  indexes: Array<{ collection: string; name: string; action: string }>;
  inventory: Record<
    string,
    {
      exists: boolean;
      v2Count?: number;
      invalidCount?: number;
      orphanCount?: number;
      duplicateIndexes?: string[];
    }
  >;
}

const execFileAsync = promisify(execFile);

async function runHandoverV2MigrationCli(
  uri: string,
  args: string[] = [],
): Promise<MigrationReport> {
  const scriptPath = path.resolve(
    __dirname,
    '../scripts/migrations/20261028-handover-v2.mjs',
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [scriptPath, ...args],
    {
      env: {
        ...process.env,
        HANDOVER_MONGODB_URI: uri,
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as MigrationReport;
}

describe('Knowledge Handover End-to-End Acceptance Suite (MongoDB 7 + Strict V2 Validators, A01–A16)', () => {
  let replSet: MongoMemoryReplSet;
  let replSetUri: string;
  let app: INestApplication;
  let server: App;
  let handoverAiService: HandoverAiService;
  let taskAssignmentService: HandoverTaskAssignmentService;
  let iamConn: Connection;
  let captureConn: Connection;
  let lifecycleConn: Connection;
  let handoverConn: Connection;
  let auditConn: Connection;

  const csrfToken = 'csrf-e2e-handover-token-0123456789abcdef';

  const orgId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d10');
  const projectId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d20');

  const leaderDId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d31');
  const leaderD2Id = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d32');
  const departingAId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d33');
  const departingA2Id = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d34');
  const successorB1Id = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d35');
  const successorB2Id = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d36');
  const memberCId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d37');
  const orgManagerId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d38');
  const outsiderId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d39');

  const docRunbookId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d41');
  const reportConfidentialId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d42');
  const noteRetryId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d43');
  const koArchitectureId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d44');
  const docRevocableId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d45');

  const taskActiveId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d61');
  const taskAmbiguousId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d62');
  const taskCancelKeepId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d63');

  const identities = new Map<string, AuthenticatedIdentity>([
    [
      'leaderD',
      {
        id: leaderDId.toHexString(),
        email: 'leader.d@continuum.local',
        name: 'Leader D',
        organizationId: orgId.toHexString(),
        roles: ['TEAM_LEADER'],
      },
    ],
    [
      'leaderD2',
      {
        id: leaderD2Id.toHexString(),
        email: 'leader.d2@continuum.local',
        name: 'Leader D2',
        organizationId: orgId.toHexString(),
        roles: ['TEAM_LEADER'],
      },
    ],
    [
      'successorB1',
      {
        id: successorB1Id.toHexString(),
        email: 'successor.b1@continuum.local',
        name: 'Successor B1',
        organizationId: orgId.toHexString(),
        roles: ['MEMBER'],
      },
    ],
    [
      'successorB2',
      {
        id: successorB2Id.toHexString(),
        email: 'successor.b2@continuum.local',
        name: 'Successor B2',
        organizationId: orgId.toHexString(),
        roles: ['MEMBER'],
      },
    ],
    [
      'memberC',
      {
        id: memberCId.toHexString(),
        email: 'member.c@continuum.local',
        name: 'Member C',
        organizationId: orgId.toHexString(),
        roles: ['MEMBER'],
      },
    ],
    [
      'orgManager',
      {
        id: orgManagerId.toHexString(),
        email: 'manager@continuum.local',
        name: 'Org Manager',
        organizationId: orgId.toHexString(),
        roles: ['ADMIN'],
      },
    ],
    [
      'outsider',
      {
        id: outsiderId.toHexString(),
        email: 'outsider@continuum.local',
        name: 'Outsider',
        organizationId: orgId.toHexString(),
        roles: ['MEMBER'],
      },
    ],
  ]);

  let aiHandler: (req: AiEngineRequest) => Promise<AiEngineResponse<unknown>>;

  const defaultAiHandler = (
    req: AiEngineRequest,
  ): Promise<AiEngineResponse<unknown>> => {
    const body = (req.body ?? {}) as {
      task?: string;
      sources?: Array<{
        kind: string;
        id: string;
        version: number;
        title: string;
        excerpts?: Array<{ locatorKind: string; locatorValue: string }>;
      }>;
    };
    if (body.task === 'SOURCE_PROPOSAL') {
      return Promise.resolve({
        status: 200,
        body: {
          task: 'SOURCE_PROPOSAL',
          candidates: (body.sources ?? []).map((s) => ({
            source: { kind: s.kind, id: s.id, version: s.version },
            reason: `Official ${s.kind} authored or maintained in scope: ${s.title}`,
          })),
        },
      });
    }
    if (body.task === 'DRAFT_GENERATION') {
      const srcs = body.sources ?? [];
      return Promise.resolve({
        status: 200,
        body: {
          task: 'DRAFT_GENERATION',
          items: srcs.slice(0, 2).map((s, idx) => ({
            title: `Handover Module ${idx + 1}: ${s.title}`,
            body: `Operational runbook and ownership details grounded in ${s.title}.`,
            requirement: `Review grounded excerpts from ${s.title} and confirm operational readiness.`,
            sources: [{ kind: s.kind, id: s.id, version: s.version }],
            citations: [
              {
                source: { kind: s.kind, id: s.id, version: s.version },
                locator: {
                  kind: s.excerpts?.[0]?.locatorKind ?? 'SECTION',
                  value: s.excerpts?.[0]?.locatorValue ?? 'doc-body-1',
                },
              },
            ],
          })),
        },
      });
    }
    const first = (body.sources ?? [])[0];
    if (!first) {
      return Promise.resolve({
        status: 200,
        body: {
          task: 'QUESTION_ANSWER',
          answerStatus: 'INSUFFICIENT_EVIDENCE',
          message:
            'No authorized current revision sources cover this question.',
          sections: [],
        },
      });
    }
    return Promise.resolve({
      status: 200,
      body: {
        task: 'QUESTION_ANSWER',
        answerStatus: 'ANSWERED',
        message: 'Answered from authorized published handover sources.',
        sections: [
          {
            text: `Grounded answer derived strictly from ${first.title}.`,
            citations: [
              {
                source: {
                  kind: first.kind,
                  id: first.id,
                  version: first.version,
                },
                locator: {
                  kind: first.excerpts?.[0]?.locatorKind ?? 'SECTION',
                  value: first.excerpts?.[0]?.locatorValue ?? 'doc-body-1',
                },
              },
            ],
          },
        ],
      },
    });
  };

  function cookieFor(actorKey: string): string {
    return `continuum_access=${actorKey}; continuum_csrf=${csrfToken}`;
  }

  function baseUrl(suffix = ''): string {
    return `/api/v1/handover/projects/${projectId.toHexString()}/handovers${suffix}`;
  }

  beforeAll(async () => {
    aiHandler = defaultAiHandler;
    replSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    replSetUri = replSet.getUri();

    // 1. Apply PR #106 V2 strict $jsonSchema validators & all 18 indexes onto continuum_handover!
    const dryRun = await runHandoverV2MigrationCli(replSetUri);
    expect(dryRun.blockers).toHaveLength(0);
    const applied = await runHandoverV2MigrationCli(replSetUri, [
      '--apply',
      '--writes-paused',
      `--expected-report-sha256=${dryRun.reportSha256}`,
    ]);
    expect(applied.applied).toBe(true);
    expect(applied.blockers).toHaveLength(0);

    const mockAuthService: Pick<
      AuthenticationApplicationService,
      'getCurrentIdentity'
    > = {
      getCurrentIdentity: (
        _authHeader?: string,
        cookieHeader?: string,
      ): Promise<AuthenticatedIdentity> => {
        const key = readCookie(cookieHeader, 'continuum_access');
        const found = key ? identities.get(key) : undefined;
        if (!found) {
          return Promise.reject(
            new UnauthorizedException({
              code: 'UNAUTHENTICATED',
              message: 'Authentication required.',
            }),
          );
        }
        return Promise.resolve(found);
      },
    };

    const aiClient: AiEngineClient = {
      request: <TResponse>(req: AiEngineRequest) =>
        aiHandler(req) as Promise<AiEngineResponse<TResponse>>,
      requestStream: () =>
        Promise.reject(new Error('Stream not used in handover e2e mock')),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSetUri, {
          dbName: HANDOVER_PERSISTENCE.databaseName,
          connectionName: HANDOVER_PERSISTENCE.databaseName,
        }),
        MongooseModule.forRoot(replSetUri, {
          dbName: IAM_PERSISTENCE.databaseName,
          connectionName: IAM_PERSISTENCE.databaseName,
        }),
        MongooseModule.forRoot(replSetUri, {
          dbName: CAPTURE_PERSISTENCE.databaseName,
          connectionName: CAPTURE_PERSISTENCE.databaseName,
        }),
        MongooseModule.forRoot(replSetUri, {
          dbName: LIFECYCLE_PERSISTENCE.databaseName,
          connectionName: LIFECYCLE_PERSISTENCE.databaseName,
        }),
        MongooseModule.forRoot(replSetUri, {
          dbName: AUDIT_DATABASE_NAME,
          connectionName: 'audit',
        }),
      ],
      controllers: [HandoverWorkflowController],
      providers: [
        {
          provide: AuthenticationApplicationService,
          useValue: mockAuthService,
        },
        {
          provide: AI_ENGINE_CLIENT,
          useValue: aiClient,
        },
        AuditService,
        OutboxService,
        HandoverIamScopeService,
        HandoverCaptureSourceService,
        HandoverLifecycleSourceService,
        TaskWorkspaceRepository,
        {
          provide: TASK_WORKSPACE_REPOSITORY,
          useExisting: TaskWorkspaceRepository,
        },
        HandoverTaskAssignmentService,
        HandoverRepository,
        HandoverSourcesService,
        HandoverAiService,
        HandoverTransferService,
        HandoverWorkflowService,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
    server = app.getHttpServer() as App;

    handoverAiService = app.get(HandoverAiService);
    taskAssignmentService = app.get(HandoverTaskAssignmentService);
    iamConn = app.get<Connection>(
      getConnectionToken(IAM_PERSISTENCE.databaseName),
    );
    captureConn = app.get<Connection>(
      getConnectionToken(CAPTURE_PERSISTENCE.databaseName),
    );
    lifecycleConn = app.get<Connection>(
      getConnectionToken(LIFECYCLE_PERSISTENCE.databaseName),
    );
    handoverConn = app.get<Connection>(
      getConnectionToken(HANDOVER_PERSISTENCE.databaseName),
    );
    auditConn = app.get<Connection>(getConnectionToken('audit'));

    // Pre-create audit_logs & outbox_events so multi-DB / multi-collection transactions never trigger DDL inside txn
    await handoverConn.db!.createCollection('outbox_events');
    await auditConn.db!.createCollection('audit_logs');

    // Initialize continuum_task with strict WORKSPACE_COLLECTION_VALIDATORS & WORKSPACE_INDEX_CATALOGUE
    const taskDb = iamConn.useDb(WORKSPACE_TASK_DATABASE_NAME, {
      useCache: true,
    }).db!;
    for (const [collName, validator] of Object.entries(
      WORKSPACE_COLLECTION_VALIDATORS,
    )) {
      await taskDb.createCollection(collName, {
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    }
    for (const [collName, specs] of Object.entries(WORKSPACE_INDEX_CATALOGUE)) {
      for (const spec of specs) {
        await taskDb.collection(collName).createIndex(spec.key, {
          name: spec.name,
          ...(spec.unique ? { unique: true } : {}),
          ...(spec.expireAfterSeconds !== undefined
            ? { expireAfterSeconds: spec.expireAfterSeconds }
            : {}),
          ...(spec.partialFilterExpression
            ? { partialFilterExpression: spec.partialFilterExpression }
            : {}),
        });
      }
    }
    await app.get(TaskWorkspaceRepository).ensureIndexes();

    // Seed IAM fixtures (project, users, org memberships, project memberships, role assignments)
    const iamDb = iamConn.db!;
    await iamDb.collection('projects').insertOne({
      _id: projectId,
      organizationId: orgId,
      name: 'Core Platform Services',
      status: 'ACTIVE',
      visibility: 'PRIVATE',
    });

    await iamDb.collection('users').insertMany([
      { _id: leaderDId, status: 'ACTIVE', fullName: 'Leader D' },
      { _id: leaderD2Id, status: 'ACTIVE', fullName: 'Leader D2' },
      {
        _id: departingAId,
        status: 'SUSPENDED',
        fullName: 'Departing Former Leader A',
      },
      { _id: departingA2Id, status: 'ACTIVE', fullName: 'Departing Member A2' },
      { _id: successorB1Id, status: 'ACTIVE', fullName: 'Successor B1' },
      { _id: successorB2Id, status: 'ACTIVE', fullName: 'Successor B2' },
      { _id: memberCId, status: 'ACTIVE', fullName: 'Member C' },
      { _id: orgManagerId, status: 'ACTIVE', fullName: 'Org Manager' },
      { _id: outsiderId, status: 'ACTIVE', fullName: 'Outsider' },
    ]);

    await iamDb.collection('organization_memberships').insertMany([
      { organizationId: orgId, userId: leaderDId, status: 'ACTIVE' },
      { organizationId: orgId, userId: leaderD2Id, status: 'ACTIVE' },
      { organizationId: orgId, userId: departingAId, status: 'REMOVED' },
      { organizationId: orgId, userId: departingA2Id, status: 'ACTIVE' },
      { organizationId: orgId, userId: successorB1Id, status: 'ACTIVE' },
      { organizationId: orgId, userId: successorB2Id, status: 'ACTIVE' },
      { organizationId: orgId, userId: memberCId, status: 'ACTIVE' },
      { organizationId: orgId, userId: orgManagerId, status: 'ACTIVE' },
      { organizationId: orgId, userId: outsiderId, status: 'ACTIVE' },
    ]);

    await iamDb.collection('project_memberships').insertMany([
      {
        organizationId: orgId,
        projectId,
        userId: leaderDId,
        status: 'ACTIVE',
      },
      {
        organizationId: orgId,
        projectId,
        userId: leaderD2Id,
        status: 'ACTIVE',
      },
      {
        organizationId: orgId,
        projectId,
        userId: departingAId,
        status: 'INACTIVE',
      },
      {
        organizationId: orgId,
        projectId,
        userId: departingA2Id,
        status: 'ACTIVE',
      },
      {
        organizationId: orgId,
        projectId,
        userId: successorB1Id,
        status: 'ACTIVE',
      },
      {
        organizationId: orgId,
        projectId,
        userId: successorB2Id,
        status: 'ACTIVE',
      },
      {
        organizationId: orgId,
        projectId,
        userId: memberCId,
        status: 'ACTIVE',
      },
    ]);

    await iamDb.collection('role_assignments').insertMany([
      {
        organizationId: orgId,
        projectId,
        userId: leaderDId,
        roleCode: 'TEAM_LEADER',
      },
      {
        organizationId: orgId,
        projectId,
        userId: leaderD2Id,
        roleCode: 'TEAM_LEADER',
      },
      {
        organizationId: orgId,
        projectId: null,
        userId: orgManagerId,
        roleCode: 'ADMIN',
      },
    ]);

    // Seed Capture & Lifecycle official sources
    const captureDb = captureConn.db!;
    await captureDb.collection('project_documents').insertMany([
      {
        _id: docRunbookId,
        organizationId: orgId,
        projectId,
        title: 'Canary Rollout Runbook',
        status: 'APPROVED',
        currentVersionNumber: 1,
        latestApprovedVersionNumber: 1,
        createdByUserId: departingAId,
      },
      {
        _id: docRevocableId,
        organizationId: orgId,
        projectId,
        title: 'Legacy Webhook Secret Rotation Guide',
        status: 'APPROVED',
        currentVersionNumber: 1,
        latestApprovedVersionNumber: 1,
        createdByUserId: departingA2Id,
      },
    ]);

    await captureDb.collection('project_document_versions').insertMany([
      {
        _id: new Types.ObjectId(),
        organizationId: orgId,
        projectId,
        documentId: docRunbookId,
        versionNumber: 1,
        title: 'Canary Rollout Runbook v1',
        content: 'Verify error budget before promoting 10% canary traffic.',
        status: 'APPROVED',
        editedByUserId: departingAId,
      },
      {
        _id: new Types.ObjectId(),
        organizationId: orgId,
        projectId,
        documentId: docRevocableId,
        versionNumber: 1,
        title: 'Legacy Webhook Secret Rotation Guide v1',
        content: 'Rotate HMAC signing keys every 90 days.',
        status: 'APPROVED',
        editedByUserId: departingA2Id,
      },
    ]);

    await captureDb.collection('work_reports').insertOne({
      _id: reportConfidentialId,
      organizationId: orgId,
      projectId,
      memberUserId: departingAId,
      reportScope: 'MEMBER',
      status: 'APPROVED',
      accomplishments: 'CONFIDENTIAL_REPORT_SECRET_PAYLOAD_DO_NOT_LEAK',
      approach: 'Internal staffing retrospective.',
      reason: 'Leadership eyes only.',
      blockers: 'None',
      nextSteps: 'Transition to D.',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-10-07T00:00:00Z'),
    });

    await captureDb.collection('work_notes').insertOne({
      _id: noteRetryId,
      organizationId: orgId,
      projectId,
      taskId: taskActiveId,
      authorUserId: departingAId,
      title: 'Outbox Retry Backoff Notes',
      whatDone: 'Configured exponential jitter',
      howSolved: 'Capped retry interval at 60s',
      whyThisWay: 'Prevent downstream overload',
      status: 'CONFIRMED',
      deletedAt: null,
    });

    await captureDb.collection('task_notes').insertOne({
      _id: new Types.ObjectId(),
      organizationId: orgId,
      projectId,
      taskId: taskActiveId,
      authorUserId: departingAId,
      content: 'Informal personal scratchpad — MUST NEVER BE PROPOSED',
    });

    const lifecycleDb = lifecycleConn.db!;
    await lifecycleDb.collection('knowledge_objects').insertOne({
      _id: koArchitectureId,
      organizationId: orgId,
      projectId,
      title: 'Event-Driven Outbox Topology',
      status: 'VERIFIED',
      currentVersionNumber: 1,
      ownerUserId: departingAId.toHexString(),
      confidentiality: 'PROJECT',
    });
    await lifecycleDb.collection('knowledge_versions').insertOne({
      _id: new Types.ObjectId(),
      organizationId: orgId,
      projectId,
      knowledgeObjectId: koArchitectureId,
      versionNumber: 1,
      title: 'Event-Driven Outbox Topology v1',
      contentMarkdown: 'Every cross-service event is persisted in outbox.',
      summary: 'Transactional outbox pattern',
    });

    // Seed continuum_task tasks (validating against strict WORKSPACE_COLLECTION_VALIDATORS)
    const now = new Date();
    await taskDb.collection(WORKSPACE_TASKS_COLLECTION).insertMany([
      {
        _id: taskActiveId,
        organizationId: orgId,
        projectId,
        key: 'PLAT-101',
        title: 'Monitor canary rollout telemetry',
        description: 'Keep p99 latency under 150ms during rollout.',
        type: 'TASK',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        assigneeId: departingAId,
        createdBy: leaderDId,
        parentId: null,
        sprintId: null,
        labels: ['handover'],
        steps: [],
        dueDate: null,
        startDate: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
      {
        _id: taskAmbiguousId,
        organizationId: orgId,
        projectId,
        key: 'PLAT-102',
        title: 'Audit dead-letter retry threshold',
        description: 'Tune DLQ alert threshold.',
        type: 'TASK',
        status: 'TODO',
        priority: 'MEDIUM',
        assigneeId: departingAId,
        createdBy: leaderDId,
        parentId: null,
        sprintId: null,
        labels: ['handover'],
        steps: [],
        dueDate: null,
        startDate: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
      {
        _id: taskCancelKeepId,
        organizationId: orgId,
        projectId,
        key: 'PLAT-103',
        title: 'Rotate staging webhook secret',
        description: 'Verify staging webhook receiver.',
        type: 'TASK',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
        assigneeId: departingA2Id,
        createdBy: leaderDId,
        parentId: null,
        sprintId: null,
        labels: ['handover'],
        steps: [],
        dueDate: null,
        startDate: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
    ]);
  });

  afterEach(async () => {
    aiHandler = defaultAiHandler;
    await handoverAiService.flushPendingJobs();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (handoverAiService) {
        await handoverAiService.flushPendingJobs();
      }
      // Final post-suite verification via PR #106 inspectHandoverV2:
      // ZERO invalid V2 documents, ZERO orphan references, ZERO blockers across all 9 collections!
      if (replSetUri) {
        const postAudit = await runHandoverV2MigrationCli(replSetUri);
        expect(postAudit.blockers).toEqual([]);
        for (const col of postAudit.collections) {
          expect(col.action).toBe('KEEP');
          const inv = postAudit.inventory[col.name];
          expect(inv?.invalidCount ?? 0).toBe(0);
          expect(inv?.orphanCount ?? 0).toBe(0);
          expect(inv?.duplicateIndexes ?? []).toEqual([]);
        }
        expect(postAudit.inventory.handovers?.v2Count).toBeGreaterThanOrEqual(
          2,
        );
        expect(
          postAudit.inventory.handover_revisions?.v2Count,
        ).toBeGreaterThanOrEqual(3);
      }
    } finally {
      if (app) {
        await app.close();
      }
      if (replSet) {
        await replSet.stop();
      }
    }
  });

  it('A01, A02, A16: creates handover without B, prevents duplicate OPEN, enforces coordinator safe receipt for Org Manager, and enforces If-Match / Idempotency-Key concurrency', async () => {
    const createKey = randomUUID();
    const createPayload = {
      departingUserId: departingAId.toHexString(),
      assignedLeaderId: leaderDId.toHexString(),
      successorUserId: null,
      teamId: null,
      targetCompletionDate: '2026-11-30T00:00:00.000Z',
      title: 'Core Platform Reliability Handover',
    };

    // Create with successorUserId = null (A01)
    const createdRes = await request(server)
      .post(baseUrl())
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', createKey)
      .send(createPayload)
      .expect(201);

    expect(createdRes.headers['cache-control']).toBe('no-store');
    const etag1 = createdRes.headers['etag'];
    expect(etag1).toMatch(/^"handover:[a-f0-9]{24}:1"$/);
    const handoverId = (createdRes.body as { handoverId: string }).handoverId;
    expect(createdRes.body).toEqual({
      operationId: createKey,
      handoverId,
      version: 1,
      status: 'OPEN',
      revisionId: null,
      replayed: false,
    });

    const detailRes = await request(server)
      .get(baseUrl(`/${handoverId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect(detailRes.body).toMatchObject({
      handover: {
        id: handoverId,
        departingUserId: departingAId.toHexString(),
        assignedLeaderId: leaderDId.toHexString(),
        successorUserId: null,
        status: 'OPEN',
        version: 1,
        assignmentVersion: 1,
      },
      publishedRevision: null,
      canComplete: false,
    });

    // A16: Replay exact same Idempotency-Key returns Idempotency-Replayed: true without creating duplicate
    const replayedRes = await request(server)
      .post(baseUrl())
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', createKey)
      .send(createPayload)
      .expect(201);
    expect(replayedRes.headers['idempotency-replayed']).toBe('true');
    expect(
      replayedRes.body as { handoverId: string; replayed: boolean },
    ).toMatchObject({
      handoverId,
      replayed: true,
    });

    // A16: Reusing same Idempotency-Key with modified payload returns 409 IDEMPOTENCY_KEY_CONFLICT
    const keyConflictRes = await request(server)
      .post(baseUrl())
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', createKey)
      .send({ ...createPayload, title: 'Different Payload Title' })
      .expect(409);
    expect((keyConflictRes.body as { code: string }).code).toBe(
      'IDEMPOTENCY_KEY_CONFLICT',
    );
    expect(keyConflictRes.headers['cache-control']).toBe('no-store');

    // A01: Duplicate OPEN handover for same (projectId, departingUserId) with fresh key fails 409
    const dupRes = await request(server)
      .post(baseUrl())
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', randomUUID())
      .send(createPayload)
      .expect(409);
    expect((dupRes.body as { code: string }).code).toBe(
      'OPEN_HANDOVER_ALREADY_EXISTS',
    );

    // Outsider on PRIVATE project receives 404 concealment
    await request(server)
      .get(baseUrl(`/${handoverId}`))
      .set('Cookie', cookieFor('outsider'))
      .expect(404);

    // A02: Org Manager (not a member of PRIVATE project) is denied confidential list (403) & detail (404),
    //      but CAN appoint eligible Project TEAM_LEADER D2 via PUT .../coordinator returning ONLY safe Receipt!
    await request(server)
      .get(baseUrl())
      .set('Cookie', cookieFor('orgManager'))
      .expect(403);
    await request(server)
      .get(baseUrl(`/${handoverId}`))
      .set('Cookie', cookieFor('orgManager'))
      .expect(404);

    const coordRes = await request(server)
      .put(baseUrl(`/${handoverId}/coordinator`))
      .set('Cookie', cookieFor('orgManager'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag1)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignedLeaderId: leaderD2Id.toHexString(),
        reason: 'Former Leader A departed; appointing Leader D2 via IAM role.',
      })
      .expect(200);

    expect(Object.keys(coordRes.body as object).sort()).toEqual([
      'handoverId',
      'operationId',
      'replayed',
      'revisionId',
      'status',
      'version',
    ]);
    const etag2 = coordRes.headers['etag'];
    expect(etag2).toBe(`"handover:${handoverId}:2"`);

    // A16: Missing If-Match returns 428 Precondition Required
    await request(server)
      .patch(baseUrl(`/${handoverId}`))
      .set('Cookie', cookieFor('leaderD2'))
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Missing If-Match test' })
      .expect(428);

    // Switch coordinator back to leaderD
    const coordBackRes = await request(server)
      .put(baseUrl(`/${handoverId}/coordinator`))
      .set('Cookie', cookieFor('orgManager'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag2)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignedLeaderId: leaderDId.toHexString(),
        reason: 'Assigning primary coordinator Leader D.',
      })
      .expect(200);
    const etag3 = coordBackRes.headers['etag'];

    // A16: Two concurrent updates with the exact same If-Match -> 1 succeeds (200), 1 fails (409 VERSION_CONFLICT)
    const [p1, p2] = await Promise.all([
      request(server)
        .patch(baseUrl(`/${handoverId}`))
        .set('Cookie', cookieFor('leaderD'))
        .set('x-csrf-token', csrfToken)
        .set('If-Match', etag3)
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Core Platform Reliability Handover A' }),
      request(server)
        .patch(baseUrl(`/${handoverId}`))
        .set('Cookie', cookieFor('leaderD'))
        .set('x-csrf-token', csrfToken)
        .set('If-Match', etag3)
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Core Platform Reliability Handover B' }),
    ]);

    const statuses = [p1.status, p2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const listRes = await request(server)
      .get(baseUrl())
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect((listRes.body as { data: Array<{ id: string }> }).data).toHaveLength(
      1,
    );
  });

  it('A03 & A12: runs AI source proposal without auto-selecting sources, handles AI generation failure + retry + manual fallback, and marks stale in-flight generation SUPERSEDED', async () => {
    const listRes = await request(server)
      .get(baseUrl())
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    const handoverId = (listRes.body as { data: Array<{ id: string }> }).data[0]
      .id;

    const detail0 = await request(server)
      .get(baseUrl(`/${handoverId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    let etag = detail0.headers['etag'];

    // A03: Propose sources
    const propRes = await request(server)
      .post(baseUrl(`/${handoverId}/source-proposals`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ query: 'rollout outbox runbook', expectedDraftVersion: 0 })
      .expect(202);

    etag = propRes.headers['etag'];
    const propJobId = (propRes.body as { id: string }).id;
    await handoverAiService.flushPendingJobs();

    const jobPoll = await request(server)
      .get(baseUrl(`/${handoverId}/jobs/${propJobId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect((jobPoll.body as { state: string }).state).toBe('SUCCEEDED');

    const candRes = await request(server)
      .get(baseUrl(`/${handoverId}/jobs/${propJobId}/candidates`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    const candidates = (
      candRes.body as {
        data: Array<{ source: { kind: string; id: string } }>;
      }
    ).data;
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.some((c) => c.source.kind === 'TASK_NOTE')).toBe(false);

    // Verify selectedSources was NOT auto-mutated by AI proposal (A03)
    const draftBefore = await request(server)
      .get(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect(
      (draftBefore.body as { selectedSources: unknown[] }).selectedSources,
    ).toEqual([]);

    // Leader selects official sources in draft so we can test AI generation failure + stale supersede (A12)
    const draftSave1 = await request(server)
      .put(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: 0,
        selectedSources: [
          {
            kind: 'PROJECT_DOCUMENT',
            id: docRunbookId.toHexString(),
            version: '1',
          },
          {
            kind: 'TASK_NOTE',
            id: noteRetryId.toHexString(),
            version: '1',
          },
        ],
        taskIds: [],
        items: [],
      })
      .expect(200);
    etag = draftSave1.headers['etag'];

    // A12 Part 1: AI Engine fails -> job records FAILED with safeErrorCode -> retry succeeds!
    aiHandler = () =>
      Promise.reject(
        new ServiceUnavailableException('Upstream LLM provider socket hang up'),
      );

    const genFailRes = await request(server)
      .post(baseUrl(`/${handoverId}/generations`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedDraftVersion: 1 })
      .expect(202);
    etag = genFailRes.headers['etag'];
    const failedJobId = (genFailRes.body as { id: string }).id;
    await handoverAiService.flushPendingJobs();

    const failedJob = await request(server)
      .get(baseUrl(`/${handoverId}/jobs/${failedJobId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect((failedJob.body as { state: string }).state).toBe('FAILED');
    expect((failedJob.body as { safeErrorCode: string }).safeErrorCode).toBe(
      'AI_ENGINE_UNAVAILABLE',
    );

    // Restore AI handler and retry job
    aiHandler = defaultAiHandler;
    await request(server)
      .post(baseUrl(`/${handoverId}/jobs/${failedJobId}/retry`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedDraftVersion: 1 })
      .expect(202);
    await handoverAiService.flushPendingJobs();

    // Re-fetch latest ETag & draftVersion because background generation applied draft update (+1 version)
    const afterRetryDraft = await request(server)
      .get(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    etag = afterRetryDraft.headers['etag'];
    const draftVerAfterRetry = (
      afterRetryDraft.body as { draftVersion: number; items: unknown[] }
    ).draftVersion;
    expect(draftVerAfterRetry).toBe(2);
    expect(
      (afterRetryDraft.body as { items: unknown[] }).items.length,
    ).toBeGreaterThanOrEqual(1);

    // A12 Part 2: Stale in-flight GENERATION must become SUPERSEDED and NEVER overwrite manual Leader edits!
    let releaseDeferredAi!: () => void;
    const aiGate = new Promise<void>((resolve) => {
      releaseDeferredAi = resolve;
    });
    let aiEntered!: () => void;
    const aiStarted = new Promise<void>((resolve) => {
      aiEntered = resolve;
    });

    aiHandler = async (req) => {
      aiEntered();
      await aiGate;
      return defaultAiHandler(req);
    };

    const staleGenRes = await request(server)
      .post(baseUrl(`/${handoverId}/generations`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedDraftVersion: draftVerAfterRetry })
      .expect(202);
    etag = staleGenRes.headers['etag'];
    const staleJobId = (staleGenRes.body as { id: string }).id;

    await aiStarted;

    // Manual Leader draft replacement occurs BEFORE in-flight AI generation finishes!
    const manualItemTitle = 'Manual Authoritative Canary Runbook Module';
    await request(server)
      .put(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: draftVerAfterRetry,
        selectedSources: [
          {
            kind: 'PROJECT_DOCUMENT',
            id: docRunbookId.toHexString(),
            version: '1',
          },
        ],
        taskIds: [],
        items: [
          {
            itemId: null,
            title: manualItemTitle,
            body: 'Manually curated by Leader D while AI job was still running.',
            requirement: 'Demonstrate canary rollback readiness.',
            isRequired: true,
            evidenceRequired: true,
            sources: [
              {
                kind: 'PROJECT_DOCUMENT',
                id: docRunbookId.toHexString(),
                version: '1',
              },
            ],
            citations: [
              {
                source: {
                  kind: 'PROJECT_DOCUMENT',
                  id: docRunbookId.toHexString(),
                  version: '1',
                },
                locator: { kind: 'SECTION', value: 'Canary Gate' },
              },
            ],
          },
        ],
      })
      .expect(200);

    // Release slow AI generation -> must mark SUPERSEDED and preserve manual draft!
    releaseDeferredAi();
    await handoverAiService.flushPendingJobs();

    const staleJobAfter = await request(server)
      .get(baseUrl(`/${handoverId}/jobs/${staleJobId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect((staleJobAfter.body as { state: string }).state).toBe('SUPERSEDED');

    const draftAfter = await request(server)
      .get(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect(
      (draftAfter.body as { items: Array<{ title: string }> }).items[0].title,
    ).toBe(manualItemTitle);
  });

  it('A04, A05, A06, A07, A08, A09, A10, A11, A13, A15: enforces item ACL fail-closed shell, gap publish, cited Q&A, evidence review loop, revision carry, B1->B2->B1 epoch reset, task transfer reconciliation without overwriting C, source CHANGED state, completion with IN_PROGRESS task, and post-completion follow-up resolution', async () => {
    const listRes = await request(server)
      .get(baseUrl())
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    const handoverId = (listRes.body as { data: Array<{ id: string }> }).data[0]
      .id;

    let detail = await request(server)
      .get(baseUrl(`/${handoverId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    let etag = detail.headers['etag'];

    // Assign Successor B1 (assignmentVersion bumps from 1 -> 2)
    const setB1 = await request(server)
      .put(baseUrl(`/${handoverId}/successor`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        successorUserId: successorB1Id.toHexString(),
        reason: 'Assigning B1 as initial successor.',
      })
      .expect(200);
    etag = setB1.headers['etag'];

    const draftBefore3 = await request(server)
      .get(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    const baseDraftVer = (draftBefore3.body as { draftVersion: number })
      .draftVersion;

    // Author 3-item draft:
    // 1. Canary Rollout Gate Verification (required + evidenceRequired, citing docRunbook v1)
    // 2. SECRET_TITLE_FROM_WORK_REPORT_MUST_NOT_LEAK (optional, citing A's WORK_REPORT v1 — readable by D, UNREADABLE by B1 -> A04!)
    // 3. Outbox Retry Edge Cases (optional, citing noteRetry v1 — published with GAP_REMAINS -> A07, A08!)
    const draft3Res = await request(server)
      .put(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: baseDraftVer,
        selectedSources: [
          {
            kind: 'PROJECT_DOCUMENT',
            id: docRunbookId.toHexString(),
            version: '1',
          },
          {
            kind: 'WORK_REPORT',
            id: reportConfidentialId.toHexString(),
            version: '1',
          },
          {
            kind: 'TASK_NOTE',
            id: noteRetryId.toHexString(),
            version: '1',
          },
          {
            kind: 'KNOWLEDGE_OBJECT',
            id: koArchitectureId.toHexString(),
            version: '1',
          },
        ],
        taskIds: [taskActiveId.toHexString(), taskAmbiguousId.toHexString()],
        items: [
          {
            itemId: null,
            title: 'Canary Rollout Gate Verification',
            body: 'Check error budget and p99 latency before 100% rollout.',
            requirement:
              'Run staging canary rehearsal and attach dashboard URL.',
            isRequired: true,
            evidenceRequired: true,
            sources: [
              {
                kind: 'PROJECT_DOCUMENT',
                id: docRunbookId.toHexString(),
                version: '1',
              },
            ],
            citations: [
              {
                source: {
                  kind: 'PROJECT_DOCUMENT',
                  id: docRunbookId.toHexString(),
                  version: '1',
                },
                locator: { kind: 'SECTION', value: 'Rollout Steps' },
              },
            ],
          },
          {
            itemId: null,
            title: 'SECRET_TITLE_FROM_WORK_REPORT_MUST_NOT_LEAK',
            body: 'SECRET_SUMMARY_FROM_WORK_REPORT_MUST_NOT_LEAK',
            requirement: 'SECRET_REQUIREMENT_MUST_NOT_LEAK',
            isRequired: false,
            evidenceRequired: false,
            sources: [
              {
                kind: 'WORK_REPORT',
                id: reportConfidentialId.toHexString(),
                version: '1',
              },
            ],
            citations: [
              {
                source: {
                  kind: 'WORK_REPORT',
                  id: reportConfidentialId.toHexString(),
                  version: '1',
                },
                locator: { kind: 'SECTION', value: 'accomplishments' },
              },
            ],
          },
          {
            itemId: null,
            title: 'Outbox Retry Edge Cases',
            body: 'Edge cases around poison-pill DLQ replay.',
            requirement: 'Review exponential jitter cap.',
            isRequired: false,
            evidenceRequired: false,
            sources: [
              {
                kind: 'TASK_NOTE',
                id: noteRetryId.toHexString(),
                version: '1',
              },
            ],
            citations: [
              {
                source: {
                  kind: 'TASK_NOTE',
                  id: noteRetryId.toHexString(),
                  version: '1',
                },
                locator: { kind: 'SECTION', value: 'howSolved' },
              },
            ],
          },
        ],
      })
      .expect(200);
    etag = draft3Res.headers['etag'];

    const draft3Loaded = await request(server)
      .get(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    const loadedItems = (
      draft3Loaded.body as {
        draftVersion: number;
        items: Array<{ itemId: string; title: string }>;
      }
    ).items;
    const rev1DraftVer = (draft3Loaded.body as { draftVersion: number })
      .draftVersion;
    const itemRequiredId = loadedItems.find((i) =>
      i.title.startsWith('Canary Rollout'),
    )!.itemId;
    const itemConfidentialId = loadedItems.find((i) =>
      i.title.startsWith('SECRET_TITLE'),
    )!.itemId;
    const itemOptionalGapId = loadedItems.find((i) =>
      i.title.startsWith('Outbox Retry'),
    )!.itemId;

    // Publish Revision #1 with GAP_REMAINS on itemOptionalGap (A07)
    const pub1Res = await request(server)
      .post(baseUrl(`/${handoverId}/revisions`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: rev1DraftVer,
        reviewNote: 'Initial handover snapshot with documented optional gap.',
        itemReviews: [
          {
            itemId: itemRequiredId,
            contentVersion: 1,
            decision: 'CONTENT_APPROVED',
            impact: 'CHANGED',
            reason: 'Verified canary runbook steps.',
          },
          {
            itemId: itemConfidentialId,
            contentVersion: 1,
            decision: 'CONTENT_APPROVED',
            impact: 'CHANGED',
            reason: 'Reviewed confidential transition notes.',
          },
          {
            itemId: itemOptionalGapId,
            contentVersion: 1,
            decision: 'GAP_REMAINS',
            impact: 'CHANGED',
            reason: 'DLQ appendix pending Q4 update.',
          },
        ],
        gapAssignments: [
          {
            itemId: itemOptionalGapId,
            ownerUserId: leaderDId.toHexString(),
            dueAt: '2026-12-15T00:00:00.000Z',
            reason: 'Awaiting Q4 DLQ replay runbook update.',
          },
        ],
      })
      .expect(201);
    etag = pub1Res.headers['etag'];
    const rev1Id = (pub1Res.body as { revisionId: string }).revisionId;

    // A04: B1 reads Revision #1 -> itemConfidential MUST be projected strictly as { itemId, access: 'UNAVAILABLE' }!
    const rev1ForB1 = await request(server)
      .get(baseUrl(`/${handoverId}/revisions/${rev1Id}`))
      .set('Cookie', cookieFor('successorB1'))
      .expect(200);
    const b1Items = (
      rev1ForB1.body as {
        items: Array<Record<string, unknown>>;
      }
    ).items;
    const b1Restricted = b1Items.find((i) => i.itemId === itemConfidentialId)!;
    expect(b1Restricted).toEqual({
      itemId: itemConfidentialId,
      access: 'UNAVAILABLE',
    });
    expect(Object.keys(b1Restricted).sort()).toEqual(['access', 'itemId']);
    expect(JSON.stringify(rev1ForB1.body)).not.toContain('SECRET_TITLE');
    expect(JSON.stringify(rev1ForB1.body)).not.toContain('SECRET_SUMMARY');
    expect(JSON.stringify(rev1ForB1.body)).not.toContain('SECRET_REQUIREMENT');

    // Leader D reads Revision #1 -> itemConfidential is AVAILABLE!
    const rev1ForD = await request(server)
      .get(baseUrl(`/${handoverId}/revisions/${rev1Id}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    const dRestricted = (
      rev1ForD.body as { items: Array<Record<string, unknown>> }
    ).items.find((i) => i.itemId === itemConfidentialId)!;
    expect(dRestricted.access).toBe('AVAILABLE');

    // A10: Task transfer BEFORE B1 accepts package MUST fail 409 PACKAGE_NOT_ACCEPTED!
    await request(server)
      .post(baseUrl(`/${handoverId}/task-transfers`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev1Id,
        assignmentVersion: 2,
        tasks: [
          {
            taskId: taskActiveId.toHexString(),
            expectedTaskVersion: 1,
          },
        ],
      })
      .expect(409);

    // A07: Even with GAP_REMAINS, B1 accepts Revision #1 package, asks cited Q&A, and acknowledges itemRequiredId!
    const accPkg1 = await request(server)
      .post(baseUrl(`/${handoverId}/acceptance`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ revisionId: rev1Id })
      .expect(200);
    etag = accPkg1.headers['etag'];

    const qaRes = await request(server)
      .post(baseUrl(`/${handoverId}/questions`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .send({
        revisionId: rev1Id,
        assignmentVersion: 2,
        question: 'How do we verify the canary rollout gate?',
      })
      .expect(200);
    expect((qaRes.body as { answerStatus: string }).answerStatus).toBe(
      'ANSWERED',
    );
    expect(JSON.stringify(qaRes.body)).not.toContain(
      reportConfidentialId.toHexString(),
    );

    const ackReq1 = await request(server)
      .post(baseUrl(`/${handoverId}/items/${itemRequiredId}/acknowledgements`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev1Id,
        contentVersion: 1,
        assignmentVersion: 2,
        decision: 'UNDERSTOOD',
        note: 'Understood canary error budget gate.',
      })
      .expect(200);
    etag = ackReq1.headers['etag'];

    const rev1AcceptanceDoc = await handoverConn
      .db!.collection('handover_acceptances')
      .findOne({
        handoverId: new Types.ObjectId(handoverId),
        revisionId: new Types.ObjectId(rev1Id),
        itemId: new Types.ObjectId(itemRequiredId),
        kind: 'ITEM',
      });
    const rev1ItemAcceptanceId = rev1AcceptanceDoc!._id.toHexString();

    // A09: Evidence validation — non-HTTPS link rejected 400
    await request(server)
      .post(baseUrl(`/${handoverId}/items/${itemRequiredId}/evidence`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev1Id,
        contentVersion: 1,
        assignmentVersion: 2,
        resultText: 'Insecure link test',
        links: ['http://example.com/runbook'],
      })
      .expect(400);

    // A09: B1 submits HTTPS evidence -> Leader D requests changes -> B1 resubmits -> Leader D accepts
    const ev1Res = await request(server)
      .post(baseUrl(`/${handoverId}/items/${itemRequiredId}/evidence`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev1Id,
        contentVersion: 1,
        assignmentVersion: 2,
        resultText: 'Executed staging canary rehearsal.',
        links: ['https://grafana.continuum.example/d/canary-rehearsal'],
      })
      .expect(201);
    etag = ev1Res.headers['etag'];
    const ev1Id = (ev1Res.body as { id: string }).id;

    // B1 cannot review own evidence (403)
    await request(server)
      .post(
        baseUrl(
          `/${handoverId}/items/${itemRequiredId}/evidence/${ev1Id}/reviews`,
        ),
      )
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev1Id,
        evidenceId: ev1Id,
        outcome: 'ACCEPTED',
        note: 'Self-approval attempt',
      })
      .expect(403);

    const revEvChanges = await request(server)
      .post(
        baseUrl(
          `/${handoverId}/items/${itemRequiredId}/evidence/${ev1Id}/reviews`,
        ),
      )
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev1Id,
        evidenceId: ev1Id,
        outcome: 'CHANGES_REQUESTED',
        note: 'Please include rollback drill verification.',
      })
      .expect(200);
    etag = revEvChanges.headers['etag'];

    const ev2Res = await request(server)
      .post(baseUrl(`/${handoverId}/items/${itemRequiredId}/evidence`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev1Id,
        contentVersion: 1,
        assignmentVersion: 2,
        resultText:
          'Completed staging canary rehearsal AND automated rollback drill.',
        links: ['https://grafana.continuum.example/d/canary-rollback-drill'],
      })
      .expect(201);
    etag = ev2Res.headers['etag'];
    const ev2Id = (ev2Res.body as { id: string }).id;

    const revEvAccepted = await request(server)
      .post(
        baseUrl(
          `/${handoverId}/items/${itemRequiredId}/evidence/${ev2Id}/reviews`,
        ),
      )
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev1Id,
        evidenceId: ev2Id,
        outcome: 'ACCEPTED',
        note: 'Rollback drill verified.',
      })
      .expect(200);
    etag = revEvAccepted.headers['etag'];

    // Inspect evidence detail read endpoint
    const evDetail = await request(server)
      .get(baseUrl(`/${handoverId}/items/${itemRequiredId}/evidence`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect(
      (evDetail.body as { data: Array<{ review: string }> }).data[0].review,
    ).toBe('ACCEPTED');

    // A05: Leader D updates itemConfidential to cite KNOWLEDGE_OBJECT (readable by B1!) while keeping itemRequiredId UNCHANGED,
    //      then publishes Revision #2 -> itemRequiredId carries B1's item acceptance with carriedFromAcceptanceId!
    const rev2ItemsPayload = [
      {
        itemId: itemRequiredId,
        title: 'Canary Rollout Gate Verification',
        body: 'Check error budget and p99 latency before 100% rollout.',
        requirement: 'Run staging canary rehearsal and attach dashboard URL.',
        isRequired: true,
        evidenceRequired: true,
        sources: [
          {
            kind: 'PROJECT_DOCUMENT',
            id: docRunbookId.toHexString(),
            version: '1',
          },
        ],
        citations: [
          {
            source: {
              kind: 'PROJECT_DOCUMENT',
              id: docRunbookId.toHexString(),
              version: '1',
            },
            locator: { kind: 'SECTION', value: 'Rollout Steps' },
          },
        ],
      },
      {
        itemId: itemConfidentialId,
        title: 'Event-Driven Outbox Topology Overview',
        body: 'Replaced private report with shared Knowledge Object.',
        requirement: 'Confirm transactional outbox message ordering.',
        isRequired: false,
        evidenceRequired: false,
        sources: [
          {
            kind: 'KNOWLEDGE_OBJECT',
            id: koArchitectureId.toHexString(),
            version: '1',
          },
        ],
        citations: [
          {
            source: {
              kind: 'KNOWLEDGE_OBJECT',
              id: koArchitectureId.toHexString(),
              version: '1',
            },
            locator: { kind: 'SECTION', value: 'Topology' },
          },
        ],
      },
      {
        itemId: itemOptionalGapId,
        title: 'Outbox Retry Edge Cases',
        body: 'Edge cases around poison-pill DLQ replay.',
        requirement: 'Review exponential jitter cap.',
        isRequired: false,
        evidenceRequired: false,
        sources: [
          {
            kind: 'TASK_NOTE',
            id: noteRetryId.toHexString(),
            version: '1',
          },
        ],
        citations: [
          {
            source: {
              kind: 'TASK_NOTE',
              id: noteRetryId.toHexString(),
              version: '1',
            },
            locator: { kind: 'SECTION', value: 'howSolved' },
          },
        ],
      },
    ];

    const draftRev2 = await request(server)
      .put(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: rev1DraftVer,
        selectedSources: [
          {
            kind: 'PROJECT_DOCUMENT',
            id: docRunbookId.toHexString(),
            version: '1',
          },
          {
            kind: 'KNOWLEDGE_OBJECT',
            id: koArchitectureId.toHexString(),
            version: '1',
          },
          {
            kind: 'TASK_NOTE',
            id: noteRetryId.toHexString(),
            version: '1',
          },
        ],
        taskIds: [taskActiveId.toHexString(), taskAmbiguousId.toHexString()],
        items: rev2ItemsPayload,
      })
      .expect(200);
    etag = draftRev2.headers['etag'];
    const rev2DraftVer = rev1DraftVer + 1;

    const pub2Res = await request(server)
      .post(baseUrl(`/${handoverId}/revisions`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: rev2DraftVer,
        reviewNote:
          'Revision #2 replacing restricted report with shared Knowledge Object.',
        itemReviews: [
          {
            itemId: itemRequiredId,
            contentVersion: 1,
            decision: 'CONTENT_APPROVED',
            impact: 'UNCHANGED',
            reason: 'Unchanged canary runbook item.',
          },
          {
            itemId: itemConfidentialId,
            contentVersion: 2,
            decision: 'CONTENT_APPROVED',
            impact: 'CHANGED',
            reason: 'Replaced with shared Knowledge Object.',
          },
          {
            itemId: itemOptionalGapId,
            contentVersion: 1,
            decision: 'GAP_REMAINS',
            impact: 'UNCHANGED',
            reason: 'Still awaiting Q4 DLQ appendix.',
          },
        ],
        gapAssignments: [
          {
            itemId: itemOptionalGapId,
            ownerUserId: leaderDId.toHexString(),
            dueAt: '2026-12-15T00:00:00.000Z',
            reason: 'Awaiting Q4 DLQ replay runbook update.',
          },
        ],
      })
      .expect(201);
    etag = pub2Res.headers['etag'];
    const rev2Id = (pub2Res.body as { revisionId: string }).revisionId;

    // Verify Revision #2 carried itemRequiredId acceptance with provenance carriedFromAcceptanceId, while package acceptance is reset!
    const carriedRow = await handoverConn
      .db!.collection('handover_acceptances')
      .findOne({
        handoverId: new Types.ObjectId(handoverId),
        revisionId: new Types.ObjectId(rev2Id),
        itemId: new Types.ObjectId(itemRequiredId),
        kind: 'ITEM',
      });
    expect(carriedRow).toBeTruthy();
    expect(
      (carriedRow?.carriedFromAcceptanceId as Types.ObjectId)?.toHexString(),
    ).toBe(rev1ItemAcceptanceId);

    const detailRev2ForD = await request(server)
      .get(baseUrl(`/${handoverId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    // Package acceptance reset on new Revision #2 -> TRANSFER capability is withheld until B1 accepts Revision #2!
    expect(
      (detailRev2ForD.body as { capabilities: string[] }).capabilities,
    ).not.toContain('TRANSFER');

    const rev2ForB1 = await request(server)
      .get(baseUrl(`/${handoverId}/revisions/${rev2Id}`))
      .set('Cookie', cookieFor('successorB1'))
      .expect(200);
    const rev2ItemsB1 = (
      rev2ForB1.body as {
        items: Array<{
          itemId: string;
          access: string;
          acknowledgement?: string;
        }>;
      }
    ).items;
    expect(
      rev2ItemsB1.find((i) => i.itemId === itemRequiredId)?.acknowledgement,
    ).toBe('UNDERSTOOD');
    expect(
      rev2ItemsB1.find((i) => i.itemId === itemConfidentialId)?.acknowledgement,
    ).toBe('PENDING');

    // A06: Switch successor B1 -> B2 (assignmentVersion = 3) -> B1 (assignmentVersion = 4).
    //      B1's old epoch acceptances MUST NOT be resurrected!
    const setB2 = await request(server)
      .put(baseUrl(`/${handoverId}/successor`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        successorUserId: successorB2Id.toHexString(),
        reason: 'Temporarily assigning B2.',
      })
      .expect(200);
    etag = setB2.headers['etag'];

    const setBackB1 = await request(server)
      .put(baseUrl(`/${handoverId}/successor`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        successorUserId: successorB1Id.toHexString(),
        reason: 'Re-assigning B1 under new assignment epoch 4.',
      })
      .expect(200);
    etag = setBackB1.headers['etag'];

    const detailEpoch4 = await request(server)
      .get(baseUrl(`/${handoverId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect(
      (detailEpoch4.body as { handover: { assignmentVersion: number } })
        .handover.assignmentVersion,
    ).toBe(4);

    const rev2Epoch4 = await request(server)
      .get(baseUrl(`/${handoverId}/revisions/${rev2Id}`))
      .set('Cookie', cookieFor('successorB1'))
      .expect(200);
    expect(
      (
        rev2Epoch4.body as {
          items: Array<{
            itemId: string;
            acknowledgement?: string;
          }>;
        }
      ).items.find((i) => i.itemId === itemRequiredId)?.acknowledgement,
    ).toBe('PENDING');

    // A13: Publish new version v2 of docRunbookId in Capture DB -> Revision #2 (which pinned v1) exposes sourceState: 'CHANGED'!
    await captureConn.db!.collection('project_document_versions').insertOne({
      _id: new Types.ObjectId(),
      organizationId: orgId,
      projectId,
      documentId: docRunbookId,
      versionNumber: 2,
      title: 'Canary Rollout Runbook v2',
      content: 'Added 30-minute canary bake window.',
      status: 'APPROVED',
      editedByUserId: leaderDId,
    });
    await captureConn.db!.collection('project_documents').updateOne(
      { _id: docRunbookId },
      {
        $set: {
          currentVersionNumber: 2,
          latestApprovedVersionNumber: 2,
        },
      },
    );

    const rev2ChangedSource = await request(server)
      .get(baseUrl(`/${handoverId}/revisions/${rev2Id}`))
      .set('Cookie', cookieFor('successorB1'))
      .expect(200);
    expect(
      (
        rev2ChangedSource.body as {
          items: Array<{ itemId: string; sourceState?: string }>;
        }
      ).items.find((i) => i.itemId === itemRequiredId)?.sourceState,
    ).toBe('CHANGED');

    // B1 accepts Revision #2 package in epoch 4
    const accEpoch4 = await request(server)
      .post(baseUrl(`/${handoverId}/acceptance`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ revisionId: rev2Id })
      .expect(200);
    etag = accEpoch4.headers['etag'];

    // A10 & A11: Start task transfer for [taskActiveId, taskAmbiguousId].
    // Simulate lost response AFTER taskAmbiguousId actually commits in continuum_task!
    const realAssign = taskAssignmentService.assignTaskForHandover.bind(
      taskAssignmentService,
    );
    jest
      .spyOn(taskAssignmentService, 'assignTaskForHandover')
      .mockImplementation(async (input) => {
        const res = await realAssign(input);
        if (input.taskId === taskAmbiguousId.toHexString()) {
          throw new Error('Simulated network timeout after Task DB commit');
        }
        return res;
      });

    const transferStartRes = await request(server)
      .post(baseUrl(`/${handoverId}/task-transfers`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev2Id,
        assignmentVersion: 4,
        tasks: [
          {
            taskId: taskActiveId.toHexString(),
            expectedTaskVersion: 1,
          },
          {
            taskId: taskAmbiguousId.toHexString(),
            expectedTaskVersion: 1,
          },
        ],
      })
      .expect(202);
    etag = transferStartRes.headers['etag'];
    jest.restoreAllMocks();

    const transferId = (transferStartRes.body as { id: string; state: string })
      .id;
    expect((transferStartRes.body as { state: string }).state).toBe('UNKNOWN');

    // A11: While UNKNOWN child exists, setHandoverSuccessor and cancelHandover are FENCED (409 UNRESOLVED_TASK_TRANSFER_FENCE)!
    const fencedSucc = await request(server)
      .put(baseUrl(`/${handoverId}/successor`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        successorUserId: successorB2Id.toHexString(),
        reason: 'Blocked while UNKNOWN transfer exists',
      })
      .expect(409);
    expect((fencedSucc.body as { code: string }).code).toBe(
      'UNRESOLVED_TASK_TRANSFER_FENCE',
    );

    const fencedCancel = await request(server)
      .post(baseUrl(`/${handoverId}/cancellation`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Blocked while UNKNOWN transfer exists' })
      .expect(409);
    expect((fencedCancel.body as { code: string }).code).toBe(
      'UNRESOLVED_TASK_TRANSFER_FENCE',
    );

    // Meanwhile in continuum_task, taskAmbiguousId (which committed to B1 at v2) is legitimately reassigned to Member C (v3)!
    const taskDb = iamConn.useDb(WORKSPACE_TASK_DATABASE_NAME, {
      useCache: true,
    }).db!;
    await taskDb.collection(WORKSPACE_TASKS_COLLECTION).updateOne(
      { _id: taskAmbiguousId },
      {
        $set: { assigneeId: memberCId, updatedAt: new Date() },
        $inc: { version: 1 },
      },
    );

    // A10: Reconcile transfer -> MUST report PARTIAL ([CONFIRMED, CONFLICT]) with TASK_REASSIGNED_AFTER_DISPATCH and MUST NOT overwrite Member C!
    const reconcileRes = await request(server)
      .post(
        baseUrl(`/${handoverId}/task-transfers/${transferId}/reconciliation`),
      )
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ transferId })
      .expect(200);
    etag = reconcileRes.headers['etag'];
    expect((reconcileRes.body as { state: string }).state).toBe('PARTIAL');

    const reconciledTasks = (
      reconcileRes.body as {
        tasks: Array<{
          taskId: string;
          state: string;
          safeErrorCode: string | null;
        }>;
      }
    ).tasks;
    expect(
      reconciledTasks.find((t) => t.taskId === taskAmbiguousId.toHexString()),
    ).toMatchObject({
      state: 'CONFLICT',
      safeErrorCode: 'TASK_REASSIGNED_AFTER_DISPATCH',
    });

    const taskAmbiguousInDb = await taskDb
      .collection(WORKSPACE_TASKS_COLLECTION)
      .findOne({ _id: taskAmbiguousId });
    expect(
      (taskAmbiguousInDb?.assigneeId as Types.ObjectId).toHexString(),
    ).toBe(memberCId.toHexString());
    expect(taskAmbiguousInDb?.version).toBe(3);

    // Leader D updates draft taskIds to keep ONLY taskActiveId (now version 2, assigned to B1, status IN_PROGRESS — NOT DONE!)
    // and publishes clean Revision #3
    const draftCleanTasks = await request(server)
      .put(baseUrl(`/${handoverId}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: rev2DraftVer,
        selectedSources: [
          {
            kind: 'PROJECT_DOCUMENT',
            id: docRunbookId.toHexString(),
            version: '1',
          },
          {
            kind: 'KNOWLEDGE_OBJECT',
            id: koArchitectureId.toHexString(),
            version: '1',
          },
          {
            kind: 'TASK_NOTE',
            id: noteRetryId.toHexString(),
            version: '1',
          },
        ],
        taskIds: [taskActiveId.toHexString()],
        items: rev2ItemsPayload,
      })
      .expect(200);
    etag = draftCleanTasks.headers['etag'];
    const rev3DraftVer = rev2DraftVer + 1;

    const pub3Res = await request(server)
      .post(baseUrl(`/${handoverId}/revisions`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: rev3DraftVer,
        reviewNote: 'Revision #3 with reconciled active task scope.',
        itemReviews: [
          {
            itemId: itemRequiredId,
            contentVersion: 1,
            decision: 'CONTENT_APPROVED',
            impact: 'UNCHANGED',
            reason: 'Unchanged.',
          },
          {
            itemId: itemConfidentialId,
            contentVersion: 2,
            decision: 'CONTENT_APPROVED',
            impact: 'UNCHANGED',
            reason: 'Unchanged.',
          },
          {
            itemId: itemOptionalGapId,
            contentVersion: 1,
            decision: 'GAP_REMAINS',
            impact: 'UNCHANGED',
            reason: 'Tracked in post-handover follow-up.',
          },
        ],
        gapAssignments: [
          {
            itemId: itemOptionalGapId,
            ownerUserId: leaderDId.toHexString(),
            dueAt: '2026-12-15T00:00:00.000Z',
            reason: 'Awaiting Q4 DLQ replay runbook update.',
          },
        ],
      })
      .expect(201);
    etag = pub3Res.headers['etag'];
    const rev3Id = (pub3Res.body as { revisionId: string }).revisionId;

    // B1 accepts Revision #3 package, acknowledges itemRequiredId & itemConfidentialId, and completes evidence review
    const accRev3 = await request(server)
      .post(baseUrl(`/${handoverId}/acceptance`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ revisionId: rev3Id })
      .expect(200);
    etag = accRev3.headers['etag'];

    const ackReqRev3 = await request(server)
      .post(baseUrl(`/${handoverId}/items/${itemRequiredId}/acknowledgements`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev3Id,
        contentVersion: 1,
        assignmentVersion: 4,
        decision: 'UNDERSTOOD',
        note: 'Confirmed canary gate.',
      })
      .expect(200);
    etag = ackReqRev3.headers['etag'];

    const ackConfRev3 = await request(server)
      .post(
        baseUrl(`/${handoverId}/items/${itemConfidentialId}/acknowledgements`),
      )
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev3Id,
        contentVersion: 2,
        assignmentVersion: 4,
        decision: 'UNDERSTOOD',
        note: 'Confirmed outbox topology.',
      })
      .expect(200);
    etag = ackConfRev3.headers['etag'];

    const evRev3 = await request(server)
      .post(baseUrl(`/${handoverId}/items/${itemRequiredId}/evidence`))
      .set('Cookie', cookieFor('successorB1'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev3Id,
        contentVersion: 1,
        assignmentVersion: 4,
        resultText: 'Verified canary & rollback drill on Revision #3.',
        links: ['https://grafana.continuum.example/d/rev3-proof'],
      })
      .expect(201);
    etag = evRev3.headers['etag'];
    const evRev3Id = (evRev3.body as { id: string }).id;

    const evRev3Approve = await request(server)
      .post(
        baseUrl(
          `/${handoverId}/items/${itemRequiredId}/evidence/${evRev3Id}/reviews`,
        ),
      )
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev3Id,
        evidenceId: evRev3Id,
        outcome: 'ACCEPTED',
        note: 'Approved for completion.',
      })
      .expect(200);
    etag = evRev3Approve.headers['etag'];

    // Confirm taskActiveId on Revision #3 (already assigned to B1 at version 2 -> CONFIRMED!)
    const transferRev3 = await request(server)
      .post(baseUrl(`/${handoverId}/task-transfers`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev3Id,
        assignmentVersion: 4,
        tasks: [
          {
            taskId: taskActiveId.toHexString(),
            expectedTaskVersion: 2,
          },
        ],
      })
      .expect(202);
    etag = transferRev3.headers['etag'];
    expect((transferRev3.body as { state: string }).state).toBe('CONFIRMED');

    // A08: Unresolved optional item WITHOUT OptionalException MUST still block completion (409)!
    await request(server)
      .post(baseUrl(`/${handoverId}/completion`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev3Id,
        assignmentVersion: 4,
        reviewNote: 'Should be blocked by unexcepted optional gap',
      })
      .expect(409);

    // A08: OptionalException on a REQUIRED item MUST fail 422!
    await request(server)
      .post(baseUrl(`/${handoverId}/items/${itemRequiredId}/exceptions`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev3Id,
        contentVersion: 1,
        ownerUserId: leaderDId.toHexString(),
        dueAt: '2026-12-20T00:00:00.000Z',
        reason: 'Required items can never be bypassed with OptionalException.',
      })
      .expect(422);

    // A08: Record explicit OptionalException on optional itemOptionalGapId -> 201 FollowUp!
    const excRes = await request(server)
      .post(baseUrl(`/${handoverId}/items/${itemOptionalGapId}/exceptions`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev3Id,
        contentVersion: 1,
        ownerUserId: leaderDId.toHexString(),
        dueAt: '2026-12-20T00:00:00.000Z',
        reason: 'Tracked as post-handover follow-up with owner & due date.',
      })
      .expect(201);
    const followupId = (excRes.body as { id: string }).id;

    // Verify taskActiveId is still IN_PROGRESS (NOT DONE!) before completion (A15)
    const activeTaskDoc = await taskDb
      .collection(WORKSPACE_TASKS_COLLECTION)
      .findOne({ _id: taskActiveId });
    expect(activeTaskDoc?.status).toBe('IN_PROGRESS');

    // A15: Complete handover succeeds (200) even though transferred taskActiveId is IN_PROGRESS!
    detail = await request(server)
      .get(baseUrl(`/${handoverId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    etag = detail.headers['etag'];
    expect((detail.body as { canComplete: boolean }).canComplete).toBe(true);

    const completeRes = await request(server)
      .post(baseUrl(`/${handoverId}/completion`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: rev3Id,
        assignmentVersion: 4,
        reviewNote:
          'All required knowledge items verified; optional gap tracked in follow-up.',
      })
      .expect(200);
    expect((completeRes.body as { status: string }).status).toBe('COMPLETED');

    // A08: Follow-up has independent lifecycle & ETag and resolves cleanly AFTER parent handover is COMPLETED!
    const followUpsList = await request(server)
      .get(baseUrl(`/${handoverId}/follow-ups`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    const fu = (
      followUpsList.body as {
        data: Array<{ id: string; version: number; status: string }>;
      }
    ).data.find((f) => f.id === followupId)!;
    expect(fu.status).toBe('OPEN');

    const fuEtag = `"handover-followup:${followupId}:${fu.version}"`;
    const resolveFu = await request(server)
      .post(baseUrl(`/${handoverId}/follow-ups/${followupId}/resolution`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', fuEtag)
      .set('Idempotency-Key', randomUUID())
      .send({
        resolutionNote: 'Published Q4 DLQ replay runbook and closed gap.',
        references: [],
      })
      .expect(200);
    expect((resolveFu.body as { status: string }).status).toBe('RESOLVED');
    expect(resolveFu.headers['etag']).toBe(
      `"handover-followup:${followupId}:${fu.version + 1}"`,
    );
  });

  it('A13 (revocation) & A14 (cancellation): blocks completion when source becomes archived/unreadable, and cancelHandover preserves history & committed Task assignments', async () => {
    // Create second handover for departingA2Id
    const createRes = await request(server)
      .post(baseUrl())
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', randomUUID())
      .send({
        departingUserId: departingA2Id.toHexString(),
        assignedLeaderId: leaderDId.toHexString(),
        successorUserId: successorB2Id.toHexString(),
        teamId: null,
        targetCompletionDate: '2026-12-01T00:00:00.000Z',
        title: 'Webhook Secret Rotation Handover',
      })
      .expect(201);
    let etag = createRes.headers['etag'];
    const handover2Id = (createRes.body as { handoverId: string }).handoverId;

    const draftRes = await request(server)
      .put(baseUrl(`/${handover2Id}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: 0,
        selectedSources: [
          {
            kind: 'PROJECT_DOCUMENT',
            id: docRevocableId.toHexString(),
            version: '1',
          },
        ],
        taskIds: [taskCancelKeepId.toHexString()],
        items: [
          {
            itemId: null,
            title: 'Webhook Secret Rotation Procedure',
            body: 'Rotate HMAC keys every 90 days.',
            requirement: 'Confirm staging HMAC key rotation steps.',
            isRequired: true,
            evidenceRequired: false,
            sources: [
              {
                kind: 'PROJECT_DOCUMENT',
                id: docRevocableId.toHexString(),
                version: '1',
              },
            ],
            citations: [
              {
                source: {
                  kind: 'PROJECT_DOCUMENT',
                  id: docRevocableId.toHexString(),
                  version: '1',
                },
                locator: { kind: 'SECTION', value: 'Rotation' },
              },
            ],
          },
        ],
      })
      .expect(200);
    etag = draftRes.headers['etag'];

    const loadedDraft2 = await request(server)
      .get(baseUrl(`/${handover2Id}/draft`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    const itemRevokeId = (
      loadedDraft2.body as { items: Array<{ itemId: string }> }
    ).items[0].itemId;

    const pubRes = await request(server)
      .post(baseUrl(`/${handover2Id}/revisions`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: 1,
        reviewNote: 'Published rotation package.',
        itemReviews: [
          {
            itemId: itemRevokeId,
            contentVersion: 1,
            decision: 'CONTENT_APPROVED',
            impact: 'CHANGED',
            reason: 'Verified rotation guide.',
          },
        ],
        gapAssignments: [],
      })
      .expect(201);
    etag = pubRes.headers['etag'];
    const revId = (pubRes.body as { revisionId: string }).revisionId;

    // B2 accepts package & acknowledges item, and Leader transfers taskCancelKeepId to B2
    const accRes = await request(server)
      .post(baseUrl(`/${handover2Id}/acceptance`))
      .set('Cookie', cookieFor('successorB2'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({ revisionId: revId })
      .expect(200);
    etag = accRes.headers['etag'];

    const ackRes = await request(server)
      .post(baseUrl(`/${handover2Id}/items/${itemRevokeId}/acknowledgements`))
      .set('Cookie', cookieFor('successorB2'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: revId,
        contentVersion: 1,
        assignmentVersion: 1,
        decision: 'UNDERSTOOD',
        note: 'Understood rotation procedure.',
      })
      .expect(200);
    etag = ackRes.headers['etag'];

    const trRes = await request(server)
      .post(baseUrl(`/${handover2Id}/task-transfers`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: revId,
        assignmentVersion: 1,
        tasks: [
          {
            taskId: taskCancelKeepId.toHexString(),
            expectedTaskVersion: 1,
          },
        ],
      })
      .expect(202);
    etag = trRes.headers['etag'];
    expect((trRes.body as { state: string }).state).toBe('CONFIRMED');

    // A13: Archive/revoke docRevocableId AFTER publish -> live GET fails closed as UNAVAILABLE and blocks completion!
    await captureConn
      .db!.collection('project_documents')
      .updateOne({ _id: docRevocableId }, { $set: { status: 'ARCHIVED' } });

    const revAfterArchive = await request(server)
      .get(baseUrl(`/${handover2Id}/revisions/${revId}`))
      .set('Cookie', cookieFor('successorB2'))
      .expect(200);
    expect(
      (revAfterArchive.body as { items: Array<Record<string, unknown>> })
        .items[0],
    ).toEqual({
      itemId: itemRevokeId,
      access: 'UNAVAILABLE',
    });

    await request(server)
      .post(baseUrl(`/${handover2Id}/completion`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        revisionId: revId,
        assignmentVersion: 1,
        reviewNote: 'Blocked because source was archived',
      })
      .expect(409);

    // A14: Cancel handover -> transitions OPEN -> CANCELLED, preserves revision history, and does NOT roll back committed task assignment!
    const cancelRes = await request(server)
      .post(baseUrl(`/${handover2Id}/cancellation`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', etag)
      .set('Idempotency-Key', randomUUID())
      .send({
        reason: 'Webhook service deprecated; cancelling remaining handover.',
      })
      .expect(200);
    const cancelledEtag = cancelRes.headers['etag'];
    expect((cancelRes.body as { status: string }).status).toBe('CANCELLED');

    // Subsequent mutations on CANCELLED handover are rejected (409)
    await request(server)
      .patch(baseUrl(`/${handover2Id}`))
      .set('Cookie', cookieFor('leaderD'))
      .set('x-csrf-token', csrfToken)
      .set('If-Match', cancelledEtag)
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Should fail on CANCELLED' })
      .expect(409);

    // Published revision remains readable in history
    const revHistory = await request(server)
      .get(baseUrl(`/${handover2Id}/revisions/${revId}`))
      .set('Cookie', cookieFor('leaderD'))
      .expect(200);
    expect((revHistory.body as { id: string }).id).toBe(revId);

    // Committed Task assignment to B2 remains intact (never rolled back on cancel!)
    const taskDb = iamConn.useDb(WORKSPACE_TASK_DATABASE_NAME, {
      useCache: true,
    }).db!;
    const keptTask = await taskDb
      .collection(WORKSPACE_TASKS_COLLECTION)
      .findOne({ _id: taskCancelKeepId });
    expect((keptTask?.assigneeId as Types.ObjectId).toHexString()).toBe(
      successorB2Id.toHexString(),
    );
  });
});
