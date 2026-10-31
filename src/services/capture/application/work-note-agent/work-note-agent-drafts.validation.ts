import { UnprocessableEntityException } from '@nestjs/common';
import { AGENT_OPERATIONS } from './work-note-agent.types';
import type {
  ApplyInput,
  CreateDraftInput,
  MessageInput,
  RestoreInput,
  RevisionOperation,
  SaveInput,
  UpdateDraftInput,
} from './work-note-agent-drafts.types';
const invalid = (): never => {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Invalid WorkNote request.',
  });
};
export const objectId = (v: unknown): string =>
  typeof v === 'string' && /^[a-f\d]{24}$/i.test(v)
    ? v.toLowerCase()
    : invalid();
export const uuidInput = (v: unknown): string =>
  typeof v === 'string' &&
  /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(v)
    ? v.toLowerCase()
    : invalid();
export const positive = (v: unknown, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max
    ? v
    : invalid();
const text = (v: unknown, max: number, empty = false): string =>
  typeof v === 'string' && v.length <= max && (empty || !!v.trim())
    ? v
    : invalid();
type InputMap = {
  create: CreateDraftInput;
  update: UpdateDraftInput;
  message: MessageInput;
  apply: ApplyInput;
  save: SaveInput;
  reset: RevisionOperation;
  restore: RestoreInput;
  discard: { expectedRevision: number; discardConfirmed: true };
};
const fields: Record<keyof InputMap, readonly string[]> = {
  create: ['operationId', 'taskId', 'noteId'],
  update: ['operationId', 'expectedRevision', 'title', 'contentMarkdown'],
  message: [
    'operationId',
    'expectedRevision',
    'operation',
    'scope',
    'instruction',
    'includeWholeNoteContext',
    'selection',
    'replyToQuestionId',
    'questionDisposition',
    'answer',
  ],
  apply: ['operationId', 'expectedRevision', 'action', 'applyTitle'],
  save: ['operationId', 'expectedRevision', 'discardOriginalConfirmed'],
  reset: ['operationId', 'expectedRevision'],
  restore: ['operationId', 'expectedVersion', 'versionNumber'],
  discard: ['expectedRevision', 'discardConfirmed'],
};
export function parseDraftInput<K extends keyof InputMap>(
  kind: K,
  value: unknown,
): InputMap[K] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((k) => !fields[kind].includes(k))) return invalid();
  if (kind === 'discard') {
    if (r.discardConfirmed !== true) return invalid();
    return {
      expectedRevision: positive(r.expectedRevision),
      discardConfirmed: true,
    } as InputMap[K];
  }
  const op = uuidInput(r.operationId);
  if (kind === 'create')
    return {
      operationId: op,
      taskId: objectId(r.taskId),
      ...(r.noteId !== undefined ? { noteId: objectId(r.noteId) } : {}),
    } as InputMap[K];
  if (kind === 'restore')
    return {
      operationId: op,
      expectedVersion: positive(r.expectedVersion),
      versionNumber: positive(r.versionNumber),
    } as InputMap[K];
  const base = {
    operationId: op,
    expectedRevision: positive(r.expectedRevision),
  };
  if (kind === 'reset') return base as InputMap[K];
  if (kind === 'update')
    return {
      ...base,
      title: text(r.title, 300, true),
      contentMarkdown: text(r.contentMarkdown, 30000, true),
    } as InputMap[K];
  if (kind === 'save') {
    if (typeof r.discardOriginalConfirmed !== 'boolean') return invalid();
    return {
      ...base,
      discardOriginalConfirmed: r.discardOriginalConfirmed,
    } as InputMap[K];
  }
  if (kind === 'apply') {
    if (
      typeof r.action !== 'string' ||
      ![
        'replace_body',
        'replace_selection',
        'insert_after',
        'replace_title',
      ].includes(r.action) ||
      typeof r.applyTitle !== 'boolean'
    )
      return invalid();
    return {
      ...base,
      action: r.action,
      applyTitle: r.applyTitle,
    } as InputMap[K];
  }
  if (
    !AGENT_OPERATIONS.includes(r.operation as MessageInput['operation']) ||
    !['whole_note', 'selection'].includes(String(r.scope)) ||
    typeof r.includeWholeNoteContext !== 'boolean'
  )
    return invalid();
  const out: MessageInput = {
    ...base,
    operation: r.operation as MessageInput['operation'],
    scope: r.scope as MessageInput['scope'],
    instruction: text(r.instruction, 2000),
    includeWholeNoteContext: r.includeWholeNoteContext,
  };
  if (out.scope === 'selection') {
    if (
      out.operation === 'title' ||
      !r.selection ||
      typeof r.selection !== 'object' ||
      Array.isArray(r.selection)
    )
      return invalid();
    const s = r.selection as Record<string, unknown>;
    if (
      Object.keys(s).length !== 3 ||
      !Number.isSafeInteger(s.start) ||
      Number(s.start) < 0 ||
      !Number.isSafeInteger(s.end) ||
      Number(s.end) <= Number(s.start) ||
      Number(s.end) > 30000
    )
      return invalid();
    out.selection = {
      start: Number(s.start),
      end: Number(s.end),
      quote: text(s.quote, 30000),
    };
  } else if (r.selection !== undefined) return invalid();
  if (r.replyToQuestionId !== undefined) {
    out.replyToQuestionId = uuidInput(r.replyToQuestionId);
    if (
      typeof r.questionDisposition !== 'string' ||
      !['answered', 'skipped'].includes(r.questionDisposition)
    )
      return invalid();
    out.questionDisposition = r.questionDisposition as 'answered' | 'skipped';
    if (out.questionDisposition === 'answered')
      out.answer = text(r.answer, 2000);
    else if (r.answer !== undefined) return invalid();
  } else if (r.answer !== undefined || r.questionDisposition !== undefined)
    return invalid();
  return out as InputMap[K];
}
