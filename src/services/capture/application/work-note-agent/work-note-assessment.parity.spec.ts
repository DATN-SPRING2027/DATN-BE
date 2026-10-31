/* eslint-disable @typescript-eslint/require-await */
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import {
  loadAssessmentCorpus,
  type AssessmentCorpus,
  type AssessmentScenario,
} from '../../../../../scripts/work-note-agent/assessment-evaluation';
import { runAssessmentEvaluation } from '../../../../../scripts/work-note-agent/assessment-run';
import { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import type { WorkNotesAuthorizationService } from '../work-notes-authorization.service';
import type { WorkNotesService } from '../work-notes.service';
import type { WorkNotesActor } from '../work-notes.types';
import { extractSnapshotsFromSources } from './work-note-assessment.pipeline';
import { WorkNoteAssessmentService } from './work-note-assessment.service';
import type {
  AssessmentModelOutput,
  AssessmentView,
} from './work-note-assessment.types';

function projectComparableView(view: AssessmentView) {
  return {
    purpose: view.purpose,
    state: view.state,
    taskContextStatus: view.taskContextStatus,
    noteAdequacy: view.noteAdequacy,
    counters: view.counters,
    allowedActions: [...view.allowedActions].sort(),
    requirements: view.taskUnderstanding.requirements.map((r) => ({
      id: r.id,
      text: r.text,
      sourceRefs: r.sourceRefs,
    })),
    claims: view.claims.map((c) => ({
      id: c.id,
      text: c.text,
      originKind: c.originKind,
      supportRelation: c.supportRelation,
      verificationStatus: c.verificationStatus,
      sourceRefs: c.sourceRefs,
    })),
    coverage: view.coverage,
    gaps: view.gaps.map((g) => ({
      id: g.id,
      kind: g.kind,
      target: g.target,
      impact: g.impact,
      owner: g.owner,
      status: g.status,
      sourceRefs: g.sourceRefs,
    })),
    nextQuestion: view.nextQuestion
      ? {
          gapId: view.nextQuestion.gapId,
          text: view.nextQuestion.text,
          reason: view.nextQuestion.reason,
          options: view.nextQuestion.options,
        }
      : null,
    answers: view.answers.map((a) => ({
      gapId: a.gapId,
      target: a.target,
      disposition: a.disposition,
      answer: a.answer,
      purpose: a.purpose,
    })),
  };
}

describe('Plan v3 §2 runtime and evaluator pipeline parity', () => {
  jest.setTimeout(120000);
  let repl: MongoMemoryReplSet;
  let connection: Connection;

  beforeAll(async () => {
    repl = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1 },
    });
    connection = await mongoose
      .createConnection(repl.getUri(), { dbName: 'continuum_capture_parity' })
      .asPromise();
  });

  afterAll(async () => {
    await connection?.close();
    await repl?.stop();
  });

  beforeEach(async () => {
    await connection.dropDatabase();
    for (const c of ['work_note_agent_drafts', 'work_note_agent_operations'])
      await connection
        .db!.collection(c)
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await connection
      .db!.collection('work_note_versions')
      .createIndex({ workNoteId: 1, versionNumber: 1 }, { unique: true });
  });

  it('produces identical state, gaps, questions, carried-reset answers and Editor proposal decisions across runtime and evaluator', async () => {
    const baseScenario = structuredClone(
      loadAssessmentCorpus().scenarios.find(
        (c) => c.id === 'assessment-permission-matrix-b',
      )!,
    );
    const customScenario: AssessmentScenario = {
      ...baseScenario,
      id: 'parity-multi-turn-carry-reset',
      split: 'development',
      pilot: true,
      critical: false,
      stepDoneByIndex: [true, false],
      turns: [
        baseScenario.turns[0],
        {
          action: 'answer',
          answer:
            'Đã kiểm tra bằng tài khoản tác giả sửa được; chưa kiểm thử người ngoài project.',
          expected: {
            ...baseScenario.turns[1].expected,
            noteAdequacy: ['NEEDS_AUTHOR_INPUT', 'UNDETERMINED'],
            question: 'none',
          },
        },
        {
          action: 'reset',
          newPurpose: 'PROGRESS',
          carryAnswered: true,
          expected: {
            ...baseScenario.turns[2].expected,
            noteAdequacy: ['ENOUGH_FOR_PURPOSE'],
            question: 'none',
          },
        },
      ],
    };

    const noteQuote = customScenario.sources.find(
      (s) => s.id === 'note.body',
    )!.text;
    const step0 = customScenario.sources.find(
      (s) => s.id === 'task.step.0',
    )!.text;
    const step1 = customScenario.sources.find(
      (s) => s.id === 'task.step.1',
    )!.text;
    const turn2Answer = customScenario.turns[1].answer!;

    const turnOutputs: AssessmentModelOutput[] = [
      {
        purpose: 'COMPLETION',
        taskContextStatus: 'CLEAR',
        taskUnderstanding: {
          objective: 'Kiểm tra quyền chỉnh sửa',
          scope: 'Phân quyền chỉnh sửa ghi chú công việc.',
          requirements: [
            {
              text: step0,
              sourceRefs: [{ sourceId: 'task.step.0', quote: step0 }],
            },
            {
              text: step1,
              sourceRefs: [{ sourceId: 'task.step.1', quote: step1 }],
            },
          ],
          unknowns: [],
        },
        claims: [
          {
            text: noteQuote,
            originKind: 'AUTHOR_REPORT',
            supportRelation: 'FULL',
            sourceRefs: [{ sourceId: 'note.body', quote: noteQuote }],
          },
        ],
        coverage: [
          {
            requirementIndex: 0,
            status: 'PARTIAL',
            sourceRefs: [{ sourceId: 'note.body', quote: noteQuote }],
          },
          {
            requirementIndex: 1,
            status: 'PARTIAL',
            sourceRefs: [{ sourceId: 'note.body', quote: noteQuote }],
          },
        ],
        gaps: [
          {
            kind: 'EVIDENCE',
            needCode: 'test_context.actor',
            target:
              'vai trò/tài khoản actor đã dùng để kiểm tra quyền và kết quả từng vai trò',
            impact: 'BLOCKING',
            owner: 'NOTE_AUTHOR',
            sourceRefs: [{ sourceId: 'note.body', quote: noteQuote }],
          },
        ],
        noteAdequacy: 'NEEDS_AUTHOR_INPUT',
        nextQuestion: {
          gapIndex: 0,
          text: 'Bạn đã kiểm tra quyền chỉnh sửa với vai trò/tài khoản (actor) nào và kết quả từng vai trò ra sao?',
          reason: 'Cần xác định actor và kết quả.',
          options: [],
        },
      },
      {
        purpose: 'COMPLETION',
        taskContextStatus: 'CLEAR',
        taskUnderstanding: {
          objective: 'Kiểm tra quyền chỉnh sửa',
          scope: 'Phân quyền chỉnh sửa ghi chú công việc.',
          requirements: [
            {
              text: step0,
              sourceRefs: [{ sourceId: 'task.step.0', quote: step0 }],
            },
            {
              text: step1,
              sourceRefs: [{ sourceId: 'task.step.1', quote: step1 }],
            },
          ],
          unknowns: [],
        },
        claims: [
          {
            text: noteQuote,
            originKind: 'AUTHOR_REPORT',
            supportRelation: 'FULL',
            sourceRefs: [{ sourceId: 'note.body', quote: noteQuote }],
          },
          {
            text: 'Đã kiểm tra bằng tài khoản tác giả sửa được; chưa kiểm thử người ngoài project.',
            originKind: 'AUTHOR_REPORT',
            supportRelation: 'FULL',
            sourceRefs: [{ sourceId: '__ANSWER_ID__', quote: turn2Answer }],
          },
        ],
        coverage: [
          {
            requirementIndex: 0,
            status: 'SUPPORTED',
            sourceRefs: [
              {
                sourceId: '__ANSWER_ID__',
                quote: 'Đã kiểm tra bằng tài khoản tác giả sửa được',
              },
            ],
          },
          {
            requirementIndex: 1,
            status: 'NOT_REPORTED',
            sourceRefs: [],
          },
        ],
        gaps: [
          {
            kind: 'EVIDENCE',
            needCode: 'test_result.behavior',
            target: 'kết quả kiểm thử người ngoài project',
            impact: 'BLOCKING',
            owner: 'NOTE_AUTHOR',
            sourceRefs: [
              {
                sourceId: '__ANSWER_ID__',
                quote: 'chưa kiểm thử người ngoài project.',
              },
            ],
          },
        ],
        noteAdequacy: 'UNDETERMINED',
        nextQuestion: null,
      },
      {
        purpose: 'PROGRESS',
        taskContextStatus: 'CLEAR',
        taskUnderstanding: {
          objective: 'Kiểm tra quyền chỉnh sửa',
          scope: 'Phân quyền chỉnh sửa ghi chú công việc.',
          requirements: [
            {
              text: step0,
              sourceRefs: [{ sourceId: 'task.step.0', quote: step0 }],
            },
            {
              text: step1,
              sourceRefs: [{ sourceId: 'task.step.1', quote: step1 }],
            },
          ],
          unknowns: [],
        },
        claims: [
          {
            text: noteQuote,
            originKind: 'AUTHOR_REPORT',
            supportRelation: 'FULL',
            sourceRefs: [{ sourceId: 'note.body', quote: noteQuote }],
          },
          {
            text: turn2Answer,
            originKind: 'AUTHOR_REPORT',
            supportRelation: 'FULL',
            sourceRefs: [{ sourceId: '__ANSWER_ID__', quote: turn2Answer }],
          },
        ],
        coverage: [
          {
            requirementIndex: 0,
            status: 'SUPPORTED',
            sourceRefs: [
              {
                sourceId: '__ANSWER_ID__',
                quote: 'Đã kiểm tra bằng tài khoản tác giả sửa được',
              },
            ],
          },
          {
            requirementIndex: 1,
            status: 'NOT_REPORTED',
            sourceRefs: [],
          },
        ],
        gaps: [],
        noteAdequacy: 'ENOUGH_FOR_PURPOSE',
        nextQuestion: null,
      },
    ];

    const editorReplacement = `${noteQuote} Đã kiểm tra bằng tài khoản tác giả sửa được; chưa kiểm thử người ngoài project.`;

    const createMockFetch = () => {
      let analysisTurn = 0;
      return jest.fn(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(
            typeof init?.body === 'string' ? init.body : '{}',
          ) as {
            messages: { content: string }[];
          };
          const last = JSON.parse(body.messages.at(-1)!.content) as {
            sources?: { id: string; kind: string }[];
            operation?: string;
          };
          if (!last.sources) {
            return new Response(
              JSON.stringify({
                model: 'synthetic/parity',
                choices: [
                  {
                    finish_reason: 'stop',
                    message: {
                      content: JSON.stringify({
                        status: 'SUGGESTION_READY',
                        message: 'Bảo toàn giới hạn chưa kiểm thử.',
                        suggestion: {
                          replacementText: editorReplacement,
                          suggestedTitle: null,
                          changeSummary: ['Tổng hợp phạm vi và giữ giới hạn.'],
                        },
                        questions: [],
                        uncertainties: [],
                      }),
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 15,
                  completion_tokens: 10,
                  total_tokens: 25,
                },
              }),
              { status: 200 },
            );
          }
          const answerSourceId =
            last.sources.find((s) => s.kind === 'ANSWER')?.id ?? 'answer.none';
          const template = JSON.stringify(
            turnOutputs[analysisTurn++],
          ).replaceAll('__ANSWER_ID__', answerSourceId);
          return new Response(
            JSON.stringify({
              model: 'synthetic/parity',
              choices: [
                {
                  finish_reason: 'stop',
                  message: { content: template },
                },
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 15,
                total_tokens: 35,
              },
            }),
            { status: 200 },
          );
        },
      );
    };

    // 1. Run via evaluator harness
    const corpus: AssessmentCorpus = {
      version: 'parity-v1',
      classification: 'synthetic-only',
      splitPolicy: 'parity',
      scenarios: [customScenario],
    };
    const evalFetch = createMockFetch();
    const evalReport = await runAssessmentEvaluation(
      [
        '--live',
        '--batch',
        'release',
        '--split',
        'development',
        '--model',
        'synthetic/parity',
        '--max-attempts',
        '6',
      ],
      {
        readCorpus: () => corpus,
        readCredentials: async () => ({ apiKey: 'synthetic-secret' }),
        fetcher: evalFetch,
        writeReport: false,
      },
    );

    // 2. Run via WorkNoteAssessmentService + WorkNoteAgentModel using identical inputs and mock responses
    const runtimeFetch = createMockFetch();
    const globalFetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(runtimeFetch);
    try {
      const snapshots = extractSnapshotsFromSources(customScenario.sources, {
        revision: 1,
        stepDoneByIndex: customScenario.stepDoneByIndex,
      });
      const projectId = new Types.ObjectId().toHexString();
      const taskId = new Types.ObjectId().toHexString();
      const organizationId = new Types.ObjectId().toHexString();
      const actor: WorkNotesActor = {
        userId: new Types.ObjectId().toHexString(),
        userName: 'Parity Author',
        organizationId,
        projectId,
        canReview: false,
        canConfigure: false,
        taskContext: snapshots.taskContext,
        taskContextVersion: snapshots.taskContextVersion,
      };
      const config = new ConfigService({
        WORKNOTE_EDITOR_ENABLED: true,
        WORKNOTE_ASSESSMENT_ENABLED: true,
        WORKNOTE_AGENT_ENABLED: true,
        WORKNOTE_ASSESSMENT_ARCHITECTURE: 'combined',
        XKIRO_API_KEY: 'synthetic-secret',
        XKIRO_MODEL: 'synthetic/parity',
      });
      const service = new WorkNoteAssessmentService(
        config,
        {
          resolveProject: async () => actor,
          resolveTask: async () => actor,
        } as unknown as WorkNotesAuthorizationService,
        {} as WorkNotesService,
        new WorkNoteAgentModel(config),
        { consumeRateLimit: async () => true } as unknown as RedisService,
        connection,
      );
      const headers = { authorization: 'Bearer parity' };
      const created = await service.create(headers, projectId, {
        operationId: randomUUID(),
        taskId,
      });
      const draft = await service.update(headers, projectId, created.id, {
        operationId: randomUUID(),
        expectedRevision: created.revision,
        title: snapshots.note.title,
        contentMarkdown: snapshots.note.contentMarkdown,
      });

      const rtTurn1 = await service.assess(headers, projectId, draft.id, {
        operationId: randomUUID(),
        expectedRevision: draft.revision,
        purpose: 'COMPLETION',
      });
      const rtTurn2 = await service.reply(
        headers,
        projectId,
        draft.id,
        rtTurn1.id,
        {
          operationId: randomUUID(),
          expectedRevision: draft.revision,
          expectedAssessmentRevision: rtTurn1.revision,
          gapId: rtTurn1.nextQuestion!.gapId,
          questionId: rtTurn1.nextQuestion!.id,
          disposition: 'answered',
          answer: turn2Answer,
        },
      );
      const rtTurn3 = await service.resetAssessment(
        headers,
        projectId,
        draft.id,
        rtTurn2.id,
        {
          operationId: randomUUID(),
          expectedRevision: draft.revision,
          expectedAssessmentRevision: rtTurn2.revision,
          newPurpose: 'PROGRESS',
          carryAnswerIds: [rtTurn2.answers[0].id],
        },
      );
      const rtEditor = (await service.rewriteAssessment(
        headers,
        projectId,
        draft.id,
        rtTurn3.id,
        {
          operationId: randomUUID(),
          expectedRevision: draft.revision,
          expectedAssessmentRevision: rtTurn3.revision,
        },
      )) as { suggestion: { replacementText: string } };

      const evalAnalyses = evalReport.rows.filter((r) => r.role === 'analysis');
      const evalEditor = evalReport.rows.find((r) => r.role === 'editor');
      expect(evalAnalyses).toHaveLength(3);
      expect(evalEditor?.editorValidation?.runtimeProposalAccepted).toBe(true);

      // Verify runtime & evaluator parity across all 3 turns + Editor
      expect([rtTurn1.state, rtTurn1.noteAdequacy, rtTurn1.counters]).toEqual([
        evalAnalyses[0].runtimeState?.state,
        evalAnalyses[0].runtimeState?.noteAdequacy,
        evalAnalyses[0].runtimeState?.counters,
      ]);
      expect(rtTurn1.nextQuestion?.gapId).toMatch(
        /^gap-test_context\.actor-[a-f0-9]{16}$/u,
      );

      expect([rtTurn2.state, rtTurn2.noteAdequacy, rtTurn2.counters]).toEqual([
        evalAnalyses[1].runtimeState?.state,
        evalAnalyses[1].runtimeState?.noteAdequacy,
        evalAnalyses[1].runtimeState?.counters,
      ]);

      expect([rtTurn3.state, rtTurn3.noteAdequacy, rtTurn3.counters]).toEqual([
        evalAnalyses[2].runtimeState?.state,
        evalAnalyses[2].runtimeState?.noteAdequacy,
        evalAnalyses[2].runtimeState?.counters,
      ]);
      // Carried answer must adopt the new PROGRESS purpose in BOTH runtime and evaluator
      expect(rtTurn3.answers[0].purpose).toBe('PROGRESS');
      expect(evalAnalyses[2].answers?.[0].purpose).toBe('PROGRESS');
      expect(projectComparableView(rtTurn3).noteAdequacy).toBe(
        'ENOUGH_FOR_PURPOSE',
      );
      expect(rtEditor.suggestion.replacementText).toBe(
        evalEditor?.editorOutput?.suggestion?.replacementText,
      );
    } finally {
      globalFetchSpy.mockRestore();
    }
  });

  it('runs split architecture B end-to-end with Task Interpreter caching across turns', async () => {
    const scenario = structuredClone(
      loadAssessmentCorpus().scenarios.find(
        (c) => c.id === 'assessment-retry-upload-a',
      )!,
    );
    const corpus: AssessmentCorpus = {
      version: 'parity-split-v1',
      classification: 'synthetic-only',
      splitPolicy: 'parity',
      scenarios: [scenario],
    };
    const desc = scenario.sources.find(
      (s) => s.id === 'task.description',
    )!.text;
    const step0 = scenario.sources.find((s) => s.id === 'task.step.0')!.text;
    const note = scenario.sources.find((s) => s.id === 'note.body')!.text;

    const fetcher = jest.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        ) as {
          messages: { content: string }[];
        };
        const last = JSON.parse(body.messages.at(-1)!.content) as {
          taskSources?: unknown[];
          interpretedTask?: unknown;
          operation?: string;
        };
        const response = last.taskSources
          ? {
              taskContextStatus: 'CLEAR',
              taskUnderstanding: {
                objective: 'Tải lên lại',
                scope: desc,
                requirements: [
                  {
                    text: desc,
                    sourceRefs: [{ sourceId: 'task.description', quote: desc }],
                  },
                  {
                    text: step0,
                    sourceRefs: [{ sourceId: 'task.step.0', quote: step0 }],
                  },
                ],
                unknowns: [],
              },
            }
          : last.interpretedTask
            ? {
                purpose: 'PROGRESS',
                claims: [
                  {
                    text: note,
                    originKind: 'AUTHOR_REPORT',
                    supportRelation: 'FULL',
                    sourceRefs: [{ sourceId: 'note.body', quote: note }],
                  },
                ],
                coverage: [
                  {
                    requirementIndex: 0,
                    status: 'PARTIAL',
                    sourceRefs: [{ sourceId: 'note.body', quote: note }],
                  },
                  {
                    requirementIndex: 1,
                    status: 'NOT_REPORTED',
                    sourceRefs: [],
                  },
                ],
                gaps: [],
                noteAdequacy: 'ENOUGH_FOR_PURPOSE',
                nextQuestion: null,
              }
            : {
                status: 'SUGGESTION_READY',
                message: 'Giữ nguyên giới hạn.',
                suggestion: {
                  replacementText: note,
                  suggestedTitle: null,
                  changeSummary: ['Giữ nguyên tiến độ và giới hạn.'],
                },
                questions: [],
                uncertainties: [],
              };
        return new Response(
          JSON.stringify({
            model: 'synthetic/split',
            choices: [
              {
                finish_reason: 'stop',
                message: { content: JSON.stringify(response) },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 10,
              total_tokens: 20,
            },
          }),
          { status: 200 },
        );
      },
    );

    const report = await runAssessmentEvaluation(
      [
        '--live',
        '--batch',
        'release',
        '--split',
        'development',
        '--architecture',
        'split',
        '--model',
        'synthetic/split',
        '--max-attempts',
        '3',
      ],
      {
        readCorpus: () => corpus,
        readCredentials: async () => ({ apiKey: 'synthetic-secret' }),
        fetcher,
        writeReport: false,
      },
    );

    expect(fetcher).toHaveBeenCalledTimes(3); // 1 Interpreter + 1 Assessor + 1 Editor
    expect(report.rows[0].grade?.automatedPass).toBe(true);
    expect(report.rows[0].runtimeGrade?.automatedPass).toBe(true);
    expect(report.rows[1].editorValidation?.runtimeProposalAccepted).toBe(true);
  });
});
