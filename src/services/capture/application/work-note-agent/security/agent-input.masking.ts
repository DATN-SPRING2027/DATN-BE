import { UnprocessableEntityException } from '@nestjs/common';
import type { AgentInput } from '../work-note-agent.types';
import type { MaskVault } from './sensitive-data.masker';

export type MaskSpan = Readonly<{
  start: number;
  end: number;
  placeholder: string;
}>;

export type MaskedText = Readonly<{
  text: string;
  spans: readonly MaskSpan[];
  /** Raw offset -> masked offset; offsets inside a span snap to the placeholder start. */
  mapStart: (offset: number) => number;
  /** Raw offset -> masked offset; offsets inside a span snap to the placeholder end. */
  mapEnd: (offset: number) => number;
  /** True when the offset falls strictly inside a masked value. */
  splits: (offset: number) => boolean;
}>;

/** Exact-occurrence masking with an offset map (used before prompt construction). */
export function maskTextWithMap(text: string, vault: MaskVault): MaskedText {
  const spans: MaskSpan[] = [];
  for (const { value, placeholder } of vault.valuesLongestFirst()) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(value, from);
      if (at < 0) break;
      const end = at + value.length;
      if (!spans.some((s) => at < s.end && end > s.start))
        spans.push({ start: at, end, placeholder });
      from = at + 1;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    out += text.slice(cursor, s.start) + s.placeholder;
    cursor = s.end;
  }
  out += text.slice(cursor);

  const map = (offset: number, edge: 'start' | 'end') => {
    let shift = 0;
    for (const s of spans) {
      if (offset >= s.end) {
        shift += s.placeholder.length - (s.end - s.start);
        continue;
      }
      if (offset > s.start)
        return s.start + shift + (edge === 'end' ? s.placeholder.length : 0);
      break;
    }
    return offset + shift;
  };
  return {
    text: out,
    spans,
    mapStart: (o) => map(o, 'start'),
    mapEnd: (o) => map(o, 'end'),
    splits: (o) => spans.some((s) => o > s.start && o < s.end),
  };
}

/** Raw server-side strings of an Agent request (everything that could reach a prompt). */
export function agentInputCorpus(input: AgentInput): string[] {
  return [
    input.draft.title,
    input.draft.body,
    input.instruction,
    ...(input.task
      ? [
          input.task.title,
          input.task.description ?? '',
          ...input.task.steps.map((s) => s.text),
        ]
      : []),
    ...input.clarifications.flatMap((c) => [c.question, c.answer ?? '']),
    ...input.history.map((h) => h.content),
  ].filter(Boolean);
}

/**
 * Masks an AgentInput BEFORE prompt construction so technical-literal protection
 * can never split a secret into individually-sent fragments. Selection and
 * protected ranges are remapped onto the masked body.
 */
export function maskAgentInput(
  input: AgentInput,
  vault: MaskVault,
): AgentInput {
  if (vault.size === 0) return input;
  const plain = (s: string) => maskTextWithMap(s, vault).text;
  const body = maskTextWithMap(input.draft.body, vault);
  let selection = input.selection;
  if (selection) {
    if (body.splits(selection.start) || body.splits(selection.end))
      throw new UnprocessableEntityException({
        code: 'SELECTION_SPLITS_SENSITIVE_DATA',
        message:
          'Đoạn đang chọn cắt ngang một dữ liệu nhạy cảm (mật khẩu, token…). Hãy chọn trọn dữ liệu đó hoặc chọn đoạn khác.',
      });
    const start = body.mapStart(selection.start);
    const end = body.mapEnd(selection.end);
    selection = { start, end, quote: body.text.slice(start, end) };
  }
  return {
    ...input,
    instruction: plain(input.instruction),
    draft: { ...input.draft, title: plain(input.draft.title), body: body.text },
    task: input.task
      ? {
          ...input.task,
          title: plain(input.task.title),
          description:
            input.task.description === null
              ? null
              : plain(input.task.description),
          steps: input.task.steps.map((s) => ({ ...s, text: plain(s.text) })),
        }
      : null,
    clarifications: input.clarifications.map((c) => ({
      ...c,
      question: plain(c.question),
      ...(c.answer !== undefined ? { answer: plain(c.answer) } : {}),
    })),
    history: input.history.map((h) => ({ ...h, content: plain(h.content) })),
    ...(selection ? { selection } : {}),
    ...(input.protectedRanges
      ? {
          protectedRanges: input.protectedRanges.map((r) => ({
            start: body.mapStart(r.start),
            end: body.mapEnd(r.end),
          })),
        }
      : {}),
  };
}
