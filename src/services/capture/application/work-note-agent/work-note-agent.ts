import { randomUUID } from 'node:crypto';
import {
  FEW_SHOTS,
  OPERATION_POLICY,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
} from './work-note-agent.prompt';
import {
  findProtectedRanges,
  protectText,
  restoreText,
  snapshotHash,
  type Fragment,
} from './work-note-agent.protection';
import {
  AGENT_OPERATIONS,
  AgentValidationError,
  type AgentInput,
  type AgentMessage,
  type AgentQuestion,
  type AgentResult,
  type BoundSuggestion,
  type DraftSnapshot,
} from './work-note-agent.types';
export type {
  AgentInput,
  AgentResult,
  AgentMessage,
  BoundSuggestion,
} from './work-note-agent.types';
export { AgentValidationError } from './work-note-agent.types';

const LIMITS = {
  body: 30_000,
  title: 300,
  instruction: 2_000,
  context: 65_000,
  output: 100_000,
} as const;
function fail(
  message: string,
  code: AgentValidationError['code'] = 'INVALID_OUTPUT',
): never {
  throw new AgentValidationError(code, message);
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('Expected an object.');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(record, k))
  )
    fail('Unexpected or missing output fields.');
  return record;
}
function str(value: unknown, max: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  )
    return fail('Invalid output string.');
  return value;
}
function strings(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    return fail('Invalid output list.');
  return value.map((v: unknown) => str(v, 1_000));
}
const normalizedQuestion = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[?.!]+$/g, '')
    .replace(/\s+/g, ' ');
function validString(value: unknown, max: number, required = false): boolean {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    (!required || !!value.trim())
  );
}

export function validateAgentInput(value: AgentInput): void {
  const bad = () => fail('Invalid or oversized Agent input.', 'INVALID_INPUT');
  if (
    !value ||
    !AGENT_OPERATIONS.includes(value.operation) ||
    !['whole_note', 'selection'].includes(value.scope) ||
    !['TASK_NOTE', 'PROJECT_DOCUMENT', 'WORK_REPORT'].includes(
      value.workflow,
    ) ||
    !validString(value.instruction, LIMITS.instruction, true)
  )
    bad();
  if (
    !value.draft ||
    !Number.isSafeInteger(value.draft.revision) ||
    value.draft.revision < 1 ||
    !validString(value.draft.title, LIMITS.title) ||
    !validString(value.draft.body, LIMITS.body)
  )
    bad();
  const allowEmptyBody =
    value.scope === 'whole_note' &&
    (value.operation === 'title' || value.operation === 'custom');
  if (!allowEmptyBody && !value.draft.body.trim())
    fail(
      'Vui lòng nhập nội dung ghi chú trước khi sử dụng công cụ chỉnh sửa văn bản này.',
      'INVALID_INPUT',
    );
  if (value.scope === 'selection') {
    const s = value.selection;
    if (
      !s ||
      value.operation === 'title' ||
      !Number.isSafeInteger(s.start) ||
      !Number.isSafeInteger(s.end) ||
      s.start < 0 ||
      s.end <= s.start ||
      s.end > value.draft.body.length ||
      value.draft.body.slice(s.start, s.end) !== s.quote
    )
      bad();
  } else if (value.selection !== undefined) bad();
  if (
    value.includeWholeNoteContext !== undefined &&
    typeof value.includeWholeNoteContext !== 'boolean'
  )
    bad();
  if (value.task !== null) {
    if (
      value.workflow !== 'TASK_NOTE' ||
      !value.task ||
      !validString(value.task.title, 500, true) ||
      !(
        value.task.description === null ||
        validString(value.task.description, 20_000)
      ) ||
      !validString(value.task.status, 40) ||
      !Array.isArray(value.task.steps) ||
      value.task.steps.length > 100 ||
      value.task.steps.some(
        (s: NonNullable<AgentInput['task']>['steps'][number]) =>
          !s || !validString(s.text, 1_000) || typeof s.done !== 'boolean',
      )
    )
      bad();
  }
  if (
    !Array.isArray(value.clarifications) ||
    value.clarifications.length > 20 ||
    value.clarifications.some(
      (q: AgentInput['clarifications'][number]) =>
        !validString(q.id, 100, true) ||
        !validString(q.question, 1_000, true) ||
        !['answered', 'skipped'].includes(q.state) ||
        (q.state === 'answered' && !validString(q.answer, 2_000, true)) ||
        (q.state === 'skipped' && q.answer !== undefined),
    )
  )
    bad();
  if (
    !Array.isArray(value.history) ||
    value.history.length > 8 ||
    value.history.some(
      (h: AgentInput['history'][number]) =>
        !['user', 'assistant'].includes(h.role) ||
        !validString(h.content, 4_000, true),
    )
  )
    bad();
  if (
    value.protectedRanges !== undefined &&
    (!Array.isArray(value.protectedRanges) ||
      value.protectedRanges.length > 100 ||
      value.protectedRanges.some(
        (r: NonNullable<AgentInput['protectedRanges']>[number]) =>
          !Number.isSafeInteger(r.start) ||
          !Number.isSafeInteger(r.end) ||
          r.start < 0 ||
          r.end <= r.start ||
          r.end > value.draft.body.length,
      ))
  )
    bad();
}

export type PreparedAgentRequest = Readonly<{
  messages: readonly AgentMessage[];
  input: AgentInput;
  fragments: readonly Fragment[];
  promptVersion: string;
}>;

/** Pure prototype boundary. A future HTTP caller must authorize scope BEFORE constructing this input. */
export function prepareAgentRequest(input: AgentInput): PreparedAgentRequest {
  validateAgentInput(input);
  const snapshot = JSON.parse(JSON.stringify(input)) as AgentInput;
  const start = snapshot.selection?.start ?? 0;
  const end = snapshot.selection?.end ?? snapshot.draft.body.length;
  const target = snapshot.draft.body.slice(start, end);
  const explicit = findProtectedRanges(
    snapshot.draft.body,
    snapshot.protectedRanges,
  )
    .filter(
      (r: NonNullable<AgentInput['protectedRanges']>[number]) =>
        r.start < end && r.end > start,
    )
    .map((r: NonNullable<AgentInput['protectedRanges']>[number]) => ({
      start: Math.max(r.start, start) - start,
      end: Math.min(r.end, end) - start,
    }));
  const protectedText = protectText(target, explicit);
  const payload = {
    operation: snapshot.operation,
    scope: snapshot.scope,
    instruction: snapshot.instruction,
    workflow: snapshot.workflow,
    source: {
      title: snapshot.draft.title,
      text: protectedText.text,
      before:
        snapshot.scope === 'selection'
          ? snapshot.draft.body.slice(Math.max(0, start - 320), start)
          : '',
      after:
        snapshot.scope === 'selection'
          ? snapshot.draft.body.slice(end, end + 320)
          : '',
      wholeNote:
        snapshot.scope === 'selection' &&
        snapshot.includeWholeNoteContext === true
          ? snapshot.draft.body
          : null,
    },
    protectedFragments: protectedText.fragments,
    task: snapshot.task,
    clarifications: snapshot.clarifications.map(
      ({ question, state, answer }) => ({
        question,
        state,
        answer: answer ?? null,
      }),
    ),
    history: snapshot.history,
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > LIMITS.context)
    fail(
      'Ngữ cảnh gửi đến AI vượt quá giới hạn cho phép. Vui lòng chọn đoạn văn ngắn hơn hoặc rút gọn nội dung.',
      'INVALID_INPUT',
    );
  const messages: AgentMessage[] = [
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}\n\nOPERATION POLICY: ${OPERATION_POLICY[snapshot.operation]}`,
    },
  ];
  for (const example of FEW_SHOTS)
    messages.push(
      { role: 'user', content: JSON.stringify(example.user) },
      { role: 'assistant', content: JSON.stringify(example.assistant) },
    );
  messages.push({ role: 'user', content: serialized });
  return {
    messages,
    input: snapshot,
    fragments: protectedText.fragments,
    promptVersion: PROMPT_VERSION,
  };
}

export function parseAgentResult(
  prepared: PreparedAgentRequest,
  raw: string,
): AgentResult {
  if (typeof raw !== 'string' || raw.length > LIMITS.output)
    fail('Output is empty or exceeds the response budget.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('Model returned invalid JSON.', 'INVALID_JSON');
  }
  const value = object(parsed, [
    'status',
    'message',
    'suggestion',
    'questions',
    'uncertainties',
  ]);
  const message = str(value.message, 2_000);
  const uncertainties = strings(value.uncertainties, 8);
  if (
    !['ANSWER', 'CLARIFICATION_REQUIRED', 'SUGGESTION_READY'].includes(
      String(value.status),
    ) ||
    !Array.isArray(value.questions)
  )
    fail('Invalid result branch.');
  const questions: AgentQuestion[] = value.questions.map((q: unknown) => {
    const v = object(q, ['text', 'reason', 'options']);
    return {
      text: str(v.text, 1_000),
      reason: str(v.reason, 1_000),
      options: strings(v.options, 4),
    };
  });
  if (value.status === 'ANSWER') {
    if (value.suggestion !== null || questions.length !== 0)
      fail('ANSWER cannot contain an edit or clarification.');
    return {
      status: 'ANSWER',
      message,
      suggestion: null,
      questions,
      uncertainties,
    };
  }
  if (value.status === 'CLARIFICATION_REQUIRED') {
    if (value.suggestion !== null || questions.length !== 1)
      fail('Clarification needs exactly one question and no edit.');
    const repeated = prepared.input.clarifications.some(
      (q: AgentInput['clarifications'][number]) =>
        normalizedQuestion(q.question) ===
        normalizedQuestion(questions[0].text),
    );
    if (repeated) fail('A resolved or skipped question was asked again.');
    return {
      status: 'CLARIFICATION_REQUIRED',
      message,
      suggestion: null,
      questions,
      uncertainties,
    };
  }
  if (questions.length !== 0)
    fail('A suggestion cannot simultaneously require a clarification.');
  const suggestion = object(value.suggestion, [
    'replacementText',
    'suggestedTitle',
    'changeSummary',
  ]);
  const suggestedTitle =
    suggestion.suggestedTitle === null
      ? null
      : str(suggestion.suggestedTitle, LIMITS.title);
  const changeSummary = strings(suggestion.changeSummary, 8);
  if (changeSummary.length === 0)
    fail('A suggestion needs a short change summary.');
  let replacementText: string | null = null;
  if (prepared.input.operation === 'title') {
    if (suggestion.replacementText !== null || suggestedTitle === null)
      fail('Title operation must only propose a title.');
  } else {
    replacementText = restoreText(
      str(suggestion.replacementText, 60_000),
      prepared.fragments,
    );
    const resultingLength =
      prepared.input.draft.body.length -
      (prepared.input.selection
        ? prepared.input.selection.end - prepared.input.selection.start
        : prepared.input.draft.body.length) +
      replacementText.length;
    if (resultingLength > LIMITS.body)
      fail('Replacement would exceed the draft body budget.');
  }
  if (prepared.input.scope === 'selection' && suggestedTitle !== null)
    fail('Selection cannot change the title.');
  const bound: BoundSuggestion = Object.freeze({
    id: randomUUID(),
    scope: prepared.input.scope,
    operation: prepared.input.operation,
    baseRevision: prepared.input.draft.revision,
    snapshotHash: snapshotHash(prepared.input.draft),
    ...(prepared.input.selection
      ? { selection: Object.freeze({ ...prepared.input.selection }) }
      : {}),
    replacementText,
    suggestedTitle,
    changeSummary,
    promptVersion: prepared.promptVersion,
  });
  return {
    status: 'SUGGESTION_READY',
    message,
    suggestion: bound,
    questions: [],
    uncertainties,
  };
}

/** No persistence or lifecycle transition. The host owns undo/redo and explicit Save. */
export function applySuggestion(
  draft: DraftSnapshot,
  suggestion: BoundSuggestion,
  applyTitle = false,
): DraftSnapshot {
  if (
    draft.revision !== suggestion.baseRevision ||
    snapshotHash(draft) !== suggestion.snapshotHash
  )
    fail(
      'Suggestion is stale; select again or regenerate.',
      'STALE_SUGGESTION',
    );
  let body = draft.body;
  if (suggestion.replacementText !== null) {
    if (suggestion.scope === 'selection') {
      const s = suggestion.selection;
      if (!s || body.slice(s.start, s.end) !== s.quote)
        fail('Selection anchor is stale.', 'STALE_SUGGESTION');
      body =
        body.slice(0, s.start) + suggestion.replacementText + body.slice(s.end);
    } else body = suggestion.replacementText;
  }
  const title =
    applyTitle && suggestion.suggestedTitle !== null
      ? suggestion.suggestedTitle
      : draft.title;
  if (body === draft.body && title === draft.title) return { ...draft };
  return { revision: draft.revision + 1, title, body };
}
