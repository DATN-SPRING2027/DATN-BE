import {
  classifyFact,
  contentTokens,
  extractFacts,
  factPolarity,
  sameTarget,
  statements,
  truncateFactQuote,
} from './work-note-history.facts';
import { verifyHistory } from './work-note-history.verification';
import {
  buildHistoricalContext,
  historicalContextView,
  rankNotes,
} from './work-note-history.retriever';
import {
  CONFIRM_APPLIES,
  CONFIRM_STILL_TRUE,
  dedupeClarification,
  expandHistoryConfirmation,
} from './clarification-dedup';
import type { HistoricalNote, HistoryRelation } from './history.types';
import { prepareAgentRequest } from '../work-note-agent';
import type { AgentInput } from '../work-note-agent.types';

const NOW = new Date('2026-11-02T08:00:00.000Z');
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();
const note = (
  id: string,
  text: string,
  ageDays: number,
  title = `Note ${id}`,
  extra: {
    relation?: HistoryRelation;
    taskId?: string;
    taskKey?: string;
  } = {},
): HistoricalNote => ({
  id,
  title,
  text,
  createdAt: daysAgo(ageDays),
  updatedAt: daysAgo(ageDays),
  version: 1,
  source: 'TASK_NOTE',
  ...extra,
});
const options = { maxNotes: 5, charBudget: 6000, staleDays: 14 };

describe('Historical Fact Ledger (rule-based)', () => {
  it('splits Markdown into statements and skips code blocks', () => {
    expect(
      statements(
        '## Tiến độ\n- Đã sửa API export. Chưa test staging.\n```ts\nconst x = 1;\n```\n- [x] Đã merge PR',
      ),
    ).toEqual([
      'Tiến độ',
      'Đã sửa API export.',
      'Chưa test staging.',
      'Đã merge PR',
    ]);
  });

  it('classifies kinds and polarity in Vietnamese and English', () => {
    expect(classifyFact('Đã test module cốt lõi trên staging')).toBe(
      'TEST_RESULT',
    );
    expect(classifyFact('Đã deploy production lúc 10h')).toBe('DEPLOYMENT');
    expect(classifyFact('Chốt dùng Redis thay vì Memcached')).toBe('DECISION');
    expect(factPolarity('Chưa test staging')).toBe('NEGATIVE');
    expect(factPolarity('Dự kiến deploy ngày mai')).toBe('UNCERTAIN');
    expect(factPolarity('Đã sửa lỗi timeout')).toBe('POSITIVE');
  });

  it('matches the same subject across accents and word order', () => {
    expect(
      sameTarget(
        contentTokens('Đã test module cốt lõi'),
        contentTokens('module cot loi chua test'),
      ),
    ).toBe(true);
    expect(
      sameTarget(
        contentTokens('Đã test module cốt lõi'),
        contentTokens('Deploy dịch vụ thanh toán'),
      ),
    ).toBe(false);
  });

  it('extracts quoted facts with provenance', () => {
    const [fact] = extractFacts(
      note('n1', 'Đã test module cốt lõi trên staging.', 2),
    );
    expect(fact).toMatchObject({
      noteId: 'n1',
      kind: 'TEST_RESULT',
      polarity: 'POSITIVE',
      quote: 'Đã test module cốt lõi trên staging.',
    });
  });
});

describe('Historical Information Verification', () => {
  const verify = (
    notes: HistoricalNote[],
    current = '',
    taskStatus: string | null = 'IN_PROGRESS',
  ) =>
    verifyHistory({
      facts: notes.flatMap(extractFacts),
      currentNoteText: current,
      taskStatus,
      now: NOW,
      staleDays: 14,
    });

  it('marks older statements superseded by a newer note about the same subject', () => {
    const result = verify([
      note('old', 'Chưa test module cốt lõi.', 5),
      note('new', 'Đã test module cốt lõi trên staging.', 1),
    ]);
    const old = result.facts.find((f) => f.noteId === 'old')!;
    const recent = result.facts.find((f) => f.noteId === 'new')!;
    expect(old.status).toBe('SUPERSEDED');
    expect(recent.status).toBe('CURRENT');
    expect(result.findings).toEqual([
      expect.objectContaining({
        noteId: 'old',
        reason: 'NEWER_NOTE_DIFFERS',
        relatedFactId: recent.id,
      }),
    ]);
  });

  it('flags conflicts with the note being written and with the Task status', () => {
    const conflictNow = verify(
      [note('n1', 'Đã deploy production dịch vụ export.', 2)],
      'Chưa deploy production dịch vụ export vì rollback.',
    );
    expect(conflictNow.facts[0].status).toBe('CONFLICT_CURRENT');

    const reopened = verify(
      [note('n1', 'Hoàn thành tính năng export báo cáo.', 2)],
      '',
      'IN_PROGRESS',
    );
    expect(reopened.facts[0].status).toBe('CONFLICT_TASK');
  });

  it('flags time-sensitive facts older than the threshold but keeps decisions', () => {
    const result = verify([
      note('n1', 'Đã test module cốt lõi trên staging.', 30),
      note('n2', 'Chốt dùng Redis thay vì Memcached cho cache.', 30),
    ]);
    expect(result.facts.find((f) => f.kind === 'TEST_RESULT')!.status).toBe(
      'OUTDATED',
    );
    expect(result.facts.find((f) => f.kind === 'DECISION')!.status).toBe(
      'CURRENT',
    );
  });

  it('flags contradictions inside the same note', () => {
    const result = verify([
      note(
        'n1',
        'Đã test module cốt lõi. Chưa test module cốt lõi trên staging.',
        1,
      ),
    ]);
    expect(result.facts.every((f) => f.status === 'CONFLICT_HISTORY')).toBe(
      true,
    );
  });

  it('keeps parent/child Task facts isolated from current-Task conflicts and superseding', () => {
    const result = verify(
      [
        note('self-old', 'Chưa deploy dịch vụ thanh toán.', 5, 'Self note', {
          relation: 'SELF',
          taskId: 'task-self',
        }),
        note(
          'parent-done',
          'Hoàn thành triển khai dịch vụ thanh toán.',
          1,
          'Parent note',
          {
            relation: 'PARENT',
            taskId: 'task-parent',
            taskKey: 'OPS-10',
          },
        ),
      ],
      'Chưa triển khai dịch vụ thanh toán trên cụm mới.',
      'IN_PROGRESS',
    );
    const selfFact = result.facts.find((f) => f.noteId === 'self-old')!;
    const parentFact = result.facts.find((f) => f.noteId === 'parent-done')!;
    // Parent task note must NOT supersede current task note or trigger CONFLICT_CURRENT / CONFLICT_TASK.
    expect(selfFact.status).toBe('CURRENT');
    expect(parentFact.status).toBe('CURRENT');
    expect(parentFact.relation).toBe('PARENT');
    expect(parentFact.taskKey).toBe('OPS-10');
  });
});

describe('Historical Context Builder & ranking', () => {
  it('always keeps the newest note, then ranks by relevance, capping related Task notes', () => {
    const notes = [
      note('a', 'Đã sửa giao diện đăng nhập.', 1),
      note('b', 'Đã test export báo cáo trên staging.', 9),
      note('c', 'Họp sprint planning.', 5),
      note('p1', 'Chốt chuẩn CSV cho export báo cáo.', 2, 'Parent 1', {
        relation: 'PARENT',
        taskId: 'parent-1',
        taskKey: 'OPS-10',
      }),
      note('c1', 'Đã viết script seed dữ liệu.', 1, 'Child 1', {
        relation: 'CHILD',
        taskId: 'child-1',
        taskKey: 'OPS-12',
      }),
    ];
    expect(rankNotes(notes, 'export báo cáo', 2, 0).map((n) => n.id)).toEqual([
      'a',
      'b',
    ]);
    expect(rankNotes(notes, 'export báo cáo', 2, 1).map((n) => n.id)).toEqual([
      'a',
      'b',
      'p1',
    ]);
  });

  it('respects the character budget and prefers current facts', () => {
    const long = Array.from(
      { length: 30 },
      (_, i) => `Đã test module số ${i} của hệ thống export báo cáo.`,
    ).join('\n');
    const context = buildHistoricalContext({
      notes: [note('n1', long, 1)],
      currentNoteText: '',
      taskStatus: 'IN_PROGRESS',
      now: NOW,
      options: { ...options, charBudget: 500 },
    });
    expect(context.truncated).toBe(true);
    expect(
      context.facts.reduce((s, f) => s + f.quote.length + 80, 0),
    ).toBeLessThanOrEqual(500);
  });

  it('produces a reference-based view (H1, H2…) without internal tokens', () => {
    const view = historicalContextView(
      buildHistoricalContext({
        notes: [
          note(
            '6ad7758334bd88b3f2cc844d',
            'Đã test module cốt lõi trên staging.',
            1,
          ),
        ],
        currentNoteText: '',
        taskStatus: null,
        now: NOW,
        options,
      }),
    );
    expect(view.notes[0]).toMatchObject({
      ref: 'H1',
      id: '6ad7758334bd88b3f2cc844d',
    });
    expect(view.facts[0]).toMatchObject({
      ref: 'H1',
      status: 'CURRENT',
      kind: 'TEST_RESULT',
    });
    expect(JSON.stringify(view)).not.toContain('"target"');
  });
});

describe('Intelligent Clarification (dedup)', () => {
  const context = (ageDays = 1) =>
    buildHistoricalContext({
      notes: [
        note(
          'n1',
          'Đã test module cốt lõi trên staging.',
          ageDays,
          'Tiến độ tuần 43',
        ),
      ],
      currentNoteText: '',
      taskStatus: null,
      now: NOW,
      options,
    });

  it('replaces an already-answered open question with a quoted confirmation', () => {
    const decision = dedupeClarification(
      {
        text: 'Bạn đã test module cốt lõi ở trạng thái nào?',
        reason: 'Cần xác nhận kết quả kiểm thử.',
        options: ['Đã test', 'Chưa test'],
      },
      context(),
    );
    expect(decision.action).toBe('confirm');
    if (decision.action !== 'confirm') return;
    expect(decision.question.text).toContain(
      '"Đã test module cốt lõi trên staging."',
    );
    expect(decision.question.options).toEqual([CONFIRM_STILL_TRUE]);
    expect(decision.question.reason).toContain('nhập thông tin mới');
    expect(decision.historyRef).toMatchObject({
      noteId: 'n1',
      noteTitle: 'Tiến độ tuần 43',
      status: 'CURRENT',
      quote: 'Đã test module cốt lõi trên staging.',
    });
    // Assessment answers must carry the confirmed fact, not a bare "still true".
    expect(
      expandHistoryConfirmation(CONFIRM_STILL_TRUE, decision.historyRef),
    ).toContain('"Đã test module cốt lõi trên staging."');
    expect(
      expandHistoryConfirmation('Đã thay đổi: test lại', decision.historyRef),
    ).toBe('Đã thay đổi: test lại');
    expect(expandHistoryConfirmation(CONFIRM_STILL_TRUE, undefined)).toBe(
      CONFIRM_STILL_TRUE,
    );
  });

  it('warns when the matching information is outdated', () => {
    const decision = dedupeClarification(
      { text: 'Module cốt lõi đã được test chưa?', reason: 'x', options: [] },
      context(30),
    );
    expect(decision.action === 'confirm' && decision.question.reason).toContain(
      'khá lâu',
    );
  });

  it('keeps unrelated questions', () => {
    expect(
      dedupeClarification(
        {
          text: 'Bạn đã cập nhật tài liệu API chưa?',
          reason: 'x',
          options: [],
        },
        context(),
      ),
    ).toEqual({ action: 'keep' });
  });

  it('attributes related-Task confirmations with Task key, uses CONFIRM_APPLIES, and prefers SELF over PARENT', () => {
    const relatedOnly = buildHistoricalContext({
      notes: [
        note(
          'p1',
          'Chốt dùng Redis Cluster cho module session trên staging.',
          2,
          'Kiến trúc tổng thể',
          { relation: 'PARENT', taskId: 'parent-1', taskKey: 'OPS-10' },
        ),
      ],
      currentNoteText: '',
      taskStatus: null,
      now: NOW,
      options,
    });
    // Weak overlap (< 3 shared content tokens) on related Task is NOT matched.
    expect(
      dedupeClarification(
        { text: 'Bạn dùng Redis chưa?', reason: 'x', options: [] },
        relatedOnly,
      ),
    ).toEqual({ action: 'keep' });

    // Strong overlap (>= 3 shared content tokens) asks whether the parent Task note applies here.
    const fromParent = dedupeClarification(
      {
        text: 'Module session trên staging có dùng Redis Cluster không?',
        reason: 'x',
        options: [],
      },
      relatedOnly,
    );
    expect(fromParent.action).toBe('confirm');
    if (fromParent.action !== 'confirm') return;
    expect(fromParent.question.text).toContain('Task cha OPS-10');
    expect(fromParent.question.text).toContain('áp dụng cho Task hiện tại');
    expect(fromParent.question.options).toEqual([CONFIRM_APPLIES]);
    expect(fromParent.historyRef).toMatchObject({
      relation: 'PARENT',
      taskKey: 'OPS-10',
    });
    expect(
      expandHistoryConfirmation(CONFIRM_APPLIES, fromParent.historyRef),
    ).toContain('Task cha OPS-10 áp dụng cho Task này');

    // When SELF also has a matching fact, SELF wins even if PARENT is newer.
    const both = buildHistoricalContext({
      notes: [
        note(
          'p1',
          'Chốt dùng Redis Cluster cho module session trên staging.',
          1,
          'Kiến trúc tổng thể',
          { relation: 'PARENT', taskId: 'parent-1', taskKey: 'OPS-10' },
        ),
        note(
          's1',
          'Chưa cấu hình Redis Cluster cho module session trên staging.',
          3,
          'Ghi chú của tôi',
          { relation: 'SELF', taskId: 'self-1' },
        ),
      ],
      currentNoteText: '',
      taskStatus: null,
      now: NOW,
      options,
    });
    const preferred = dedupeClarification(
      {
        text: 'Module session trên staging có dùng Redis Cluster không?',
        reason: 'x',
        options: [],
      },
      both,
    );
    expect(preferred.action).toBe('confirm');
    if (preferred.action === 'confirm') {
      expect(preferred.historyRef.relation).toBe('SELF');
      expect(preferred.question.options).toEqual([CONFIRM_STILL_TRUE]);
    }
  });
});

describe('Prompt integration', () => {
  const base: AgentInput = {
    operation: 'grammar',
    scope: 'whole_note',
    instruction: 'Sửa chính tả',
    workflow: 'TASK_NOTE',
    draft: { revision: 1, title: 'Tiến độ', body: 'Đã sửa API.' },
    task: null,
    clarifications: [],
    history: [],
  };

  it('keeps the exact legacy prompt when there is no history', () => {
    const prepared = prepareAgentRequest(base);
    expect(prepared.messages.filter((m) => m.role === 'system')).toHaveLength(
      1,
    );
    expect(prepared.messages.at(-1)!.content).not.toContain('historicalNotes');
    expect(prepared.promptVersion).not.toContain('history');
  });

  it('adds untrusted historical facts and the history policy (including related-Task attribution) when present', () => {
    const view = historicalContextView(
      buildHistoricalContext({
        notes: [
          note('n1', 'Đã test module cốt lõi trên staging.', 1),
          note(
            'p1',
            'Chốt chuẩn CSV UTF-8 cho báo cáo xuất dữ liệu.',
            2,
            'Spec cha',
            { relation: 'PARENT', taskId: 'parent-1', taskKey: 'OPS-10' },
          ),
        ],
        currentNoteText: '',
        taskStatus: null,
        now: NOW,
        options,
      }),
    );
    const prepared = prepareAgentRequest({ ...base, historicalContext: view });
    const systems = prepared.messages.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(2);
    expect(systems[1].content).toContain('KHÔNG TIN CẬY');
    expect(systems[1].content).toContain('PARENT/CHILD/LINKED');
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      historicalNotes: {
        notes: { ref: string; relation?: string; task?: string }[];
        facts: {
          ref: string;
          status: string;
          quote: string;
          relation?: string;
          task?: string;
        }[];
      };
    };
    expect(payload.historicalNotes.facts[0]).toEqual(
      expect.objectContaining({
        ref: 'H1',
        status: 'CURRENT',
        quote: 'Đã test module cốt lõi trên staging.',
      }),
    );
    expect(payload.historicalNotes.notes[1]).toEqual(
      expect.objectContaining({ relation: 'PARENT', task: 'OPS-10' }),
    );
    expect(payload.historicalNotes.facts[1]).toEqual(
      expect.objectContaining({ relation: 'PARENT', task: 'OPS-10' }),
    );
    expect(prepared.promptVersion).toContain('history.v2');
  });

  it('never slices a [[WN_SEC:...]] placeholder across the 300-char quote boundary and preserves polarity inside confirmation wrappers', () => {
    const placeholder = '[[WN_SEC:API_KEY:0123456789ab]]';
    const prefix = 'Đã kiểm thử tích hợp dịch vụ xác thực '.padEnd(285, 'a');
    const longStatement = `${prefix} ${placeholder} trên môi trường staging.`;
    const truncated = truncateFactQuote(longStatement, 300);
    expect(truncated.length).toBeLessThanOrEqual(300);
    expect(truncated).not.toContain('[[WN_SEC:API_KEY:');

    expect(
      factPolarity(
        'Tác giả xác nhận không thay đổi từ ghi chú cũ ngày 01/11/2026: "Đã test module cốt lõi trên staging."',
      ),
    ).toBe('POSITIVE');
    expect(
      factPolarity(
        'Tác giả xác nhận lại thông tin từ ghi chú cũ ngày 01/11/2026: "Chưa kiểm thử chịu tải."',
      ),
    ).toBe('NEGATIVE');
    expect(
      factPolarity(
        'Tác giả xác nhận lại thông tin từ ghi chú cũ ngày 01/11/2026: "Dự kiến tuần sau mới deploy."',
      ),
    ).toBe('UNCERTAIN');

    const ledgerFacts = extractFacts({
      id: 'ledger:1',
      title: 'Tình trạng kiểm thử tải?',
      text: 'Tác giả xác nhận lại thông tin từ ghi chú cũ ngày 01/11/2026: "Chưa kiểm thử chịu tải."',
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
      version: 1,
      source: 'CLARIFICATION_LEDGER',
      relation: 'SELF',
      taskId: 't1',
    });
    expect(ledgerFacts[0].polarity).toBe('NEGATIVE');
    expect(ledgerFacts[0].quote).toBe('Chưa kiểm thử chịu tải.');
    expect(ledgerFacts[0].target).not.toContain('tac');
    expect(ledgerFacts[0].target).not.toContain('nhan');
  });
});
