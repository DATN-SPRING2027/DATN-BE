import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AGENT_OPERATIONS, type AgentInput } from './work-note-agent.types';
import { prepareAgentRequest } from './work-note-agent';
import {
  ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
  buildAssessmentEditorInput,
  prepareAssessmentEditorRequest,
} from './work-note-assessment-editor';
import {
  ASSESSMENT_PROMPT_VERSION,
  assessmentHash,
  buildAssessmentMessages,
} from './work-note-assessment.protocol';
import {
  SPLIT_ASSESSMENT_PROMPT_VERSION,
  TASK_ASSESSOR_PROMPT_VERSION,
  TASK_INTERPRETER_PROMPT_VERSION,
  buildTaskAssessorMessages,
  buildTaskInterpreterMessages,
  type TaskInterpreterOutput,
} from './work-note-assessment-split';
import { assembleAssessment } from './work-note-assessment.state';
import {
  ASSESSMENT_PURPOSES,
  type AssessmentModelInput,
} from './work-note-assessment.types';
import type { HistoricalContextView } from './history/history.types';

export const CANONICAL_ASSESSMENT_INPUT: AssessmentModelInput = {
  purpose: 'PROGRESS',
  previous: null,
  answers: [],
  sources: [
    {
      id: 'task.title',
      kind: 'TASK',
      label: 'Task title',
      text: 'Canonical synthetic task title',
      version: 'v1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    },
    {
      id: 'task.description',
      kind: 'TASK',
      label: 'Task description',
      text: 'Return HTTP 403 when tenant_id mismatches.',
      version: 'v1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    },
    {
      id: 'task.status',
      kind: 'TASK',
      label: 'Task status (not execution evidence)',
      text: 'IN_PROGRESS',
      version: 'v1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    },
    {
      id: 'task.step.0',
      kind: 'TASK',
      label: 'Checklist 1',
      text: 'Add integration test for cross-tenant HTTP 403.',
      version: 'v1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    },
    {
      id: 'note.title',
      kind: 'NOTE',
      label: 'Note title',
      text: 'Tenant check progress',
      version: '1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    },
    {
      id: 'note.body',
      kind: 'NOTE',
      label: 'Note content',
      text: 'Implemented tenant_id guard in middleware; integration test not run yet.',
      version: '1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    },
  ],
};

export const CANONICAL_INTERPRETED_TASK: TaskInterpreterOutput = {
  taskContextStatus: 'CLEAR',
  taskUnderstanding: {
    objective: 'Enforce tenant isolation with HTTP 403.',
    scope: 'Middleware guard and cross-tenant integration test.',
    requirements: [
      {
        text: 'Return HTTP 403 when tenant_id mismatches.',
        sourceRefs: [
          {
            sourceId: 'task.description',
            quote: 'Return HTTP 403 when tenant_id mismatches.',
          },
        ],
      },
    ],
    unknowns: [],
  },
};

const CANONICAL_HISTORY_VIEW: HistoricalContextView = {
  notes: [
    {
      ref: 'N1',
      id: 'hist-note-1',
      title: 'Prior synthetic note',
      date: '2026-10-20',
      source: 'TASK_NOTE',
      relation: 'SELF',
    },
  ],
  facts: [
    {
      id: 'f1',
      ref: 'N1',
      date: '2026-10-20',
      kind: 'STATUS',
      polarity: 'POSITIVE',
      status: 'CURRENT',
      quote: 'Drafted initial middleware skeleton.',
      relation: 'SELF',
    },
  ],
  findings: [],
  truncated: false,
};

export const CANONICAL_REWRITE_INPUTS: readonly AgentInput[] =
  AGENT_OPERATIONS.map((operation) => ({
    operation,
    scope: 'whole_note',
    instruction: 'Format the existing note cleanly while preserving all facts.',
    workflow: 'TASK_NOTE',
    draft: {
      revision: 1,
      title: 'Tenant check progress',
      body: 'Implemented `tenant_id` guard in middleware; integration test not run yet.',
    },
    task: {
      title: 'Canonical synthetic task title',
      description: 'Return HTTP 403 when tenant_id mismatches.',
      status: 'IN_PROGRESS',
      steps: [
        {
          text: 'Add integration test for cross-tenant HTTP 403.',
          done: false,
        },
      ],
    },
    clarifications: [],
    history: [],
  }));

export const CANONICAL_REWRITE_WITH_HISTORY_INPUT: AgentInput = {
  ...CANONICAL_REWRITE_INPUTS[0],
  historicalContext: CANONICAL_HISTORY_VIEW,
};

export const CANONICAL_EDITOR_INPUT: AgentInput = (() => {
  const view = assembleAssessment(
    CANONICAL_ASSESSMENT_INPUT,
    {
      purpose: 'PROGRESS',
      taskContextStatus: 'CLEAR',
      taskUnderstanding: CANONICAL_INTERPRETED_TASK.taskUnderstanding,
      claims: [
        {
          text: 'Implemented tenant_id guard in middleware; integration test not run yet.',
          originKind: 'AUTHOR_REPORT',
          supportRelation: 'FULL',
          sourceRefs: [
            {
              sourceId: 'note.body',
              quote:
                'Implemented tenant_id guard in middleware; integration test not run yet.',
            },
          ],
        },
      ],
      coverage: [
        {
          requirementIndex: 0,
          status: 'PARTIAL',
          sourceRefs: [
            {
              sourceId: 'note.body',
              quote:
                'Implemented tenant_id guard in middleware; integration test not run yet.',
            },
          ],
        },
      ],
      gaps: [],
      noteAdequacy: 'ENOUGH_FOR_PURPOSE',
      nextQuestion: null,
    },
    {
      sourceRevision: 1,
      taskContextHash: 'canonical-task-hash',
      model: 'canonical/model',
      expiresAt: '2026-12-31T00:00:00.000Z',
    },
  );
  return buildAssessmentEditorInput(
    {
      revision: 1,
      title: 'Tenant check progress',
      body: 'Implemented `tenant_id` guard in middleware; integration test not run yet.',
    },
    {
      title: 'Canonical synthetic task title',
      description: 'Return HTTP 403 when tenant_id mismatches.',
      status: 'IN_PROGRESS',
      steps: [
        {
          text: 'Add integration test for cross-tenant HTTP 403.',
          done: false,
        },
      ],
    },
    view,
  );
})();

export function computeCurrentPromptFingerprints(): Record<string, string> {
  const rewriteEntries = CANONICAL_REWRITE_INPUTS.map((input) => {
    const prepared = prepareAgentRequest(input);
    return [
      `${prepared.promptVersion}#${input.operation}`,
      assessmentHash(prepared.messages.slice(0, -1)),
    ] as const;
  });
  const rewriteHistoryPrepared = prepareAgentRequest(
    CANONICAL_REWRITE_WITH_HISTORY_INPUT,
  );
  const interpreterHash = assessmentHash(
    buildTaskInterpreterMessages(CANONICAL_ASSESSMENT_INPUT).slice(0, -1),
  );
  const assessorHash = assessmentHash(
    ASSESSMENT_PURPOSES.map((purpose) =>
      buildTaskAssessorMessages(
        { ...CANONICAL_ASSESSMENT_INPUT, purpose },
        CANONICAL_INTERPRETED_TASK,
      ).slice(0, -1),
    ),
  );

  return {
    [ASSESSMENT_PROMPT_VERSION]: assessmentHash(
      ASSESSMENT_PURPOSES.map((purpose) =>
        buildAssessmentMessages({
          ...CANONICAL_ASSESSMENT_INPUT,
          purpose,
        }).slice(0, -1),
      ),
    ),
    [TASK_INTERPRETER_PROMPT_VERSION]: interpreterHash,
    [TASK_ASSESSOR_PROMPT_VERSION]: assessorHash,
    [SPLIT_ASSESSMENT_PROMPT_VERSION]: assessmentHash([
      TASK_INTERPRETER_PROMPT_VERSION,
      interpreterHash,
      TASK_ASSESSOR_PROMPT_VERSION,
      assessorHash,
    ]),
    ...Object.fromEntries(rewriteEntries),
    [`${rewriteHistoryPrepared.promptVersion}#history`]: assessmentHash(
      rewriteHistoryPrepared.messages.slice(0, -1),
    ),
    [ASSESSMENT_EDITOR_INSTRUCTION_VERSION]: assessmentHash(
      prepareAssessmentEditorRequest(CANONICAL_EDITOR_INPUT).messages.slice(
        0,
        -1,
      ),
    ),
  };
}

export function resolvePromptFingerprintsPath(): string {
  const localCandidate = resolve(__dirname, 'prompt-fingerprints.json');
  if (existsSync(localCandidate)) return localCandidate;
  return resolve(
    process.cwd(),
    'src/services/capture/application/work-note-agent/prompt-fingerprints.json',
  );
}

export function loadPromptFingerprints(): {
  schemaVersion: number;
  surfaces: Record<string, string>;
} {
  const raw = readFileSync(resolvePromptFingerprintsPath(), 'utf8');
  return JSON.parse(raw) as {
    schemaVersion: number;
    surfaces: Record<string, string>;
  };
}
