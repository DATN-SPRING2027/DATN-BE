import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

type Entry = { reserved: number; reported: number | null; settled: boolean };
type Ledger = {
  version: 1;
  maxAttempts: number;
  maxTokens: number;
  entries: Entry[];
};
/** Local cross-process accounting, not a provider invoice. Failed/unknown usage stays reserved. */
export class AssessmentPhaseBudget {
  constructor(
    private readonly file: string,
    private readonly maxAttempts: number,
    private readonly maxTokens: number,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.locked(() => {
      if (!existsSync(file))
        this.write({ version: 1, maxAttempts, maxTokens, entries: [] });
      else this.read();
    });
  }
  private locked<T>(fn: () => T): T {
    let lock: number;
    try {
      lock = openSync(this.file + '.lock', 'wx');
    } catch {
      throw Error('PHASE_BUDGET_BUSY');
    }
    try {
      return fn();
    } finally {
      closeSync(lock);
      unlinkSync(this.file + '.lock');
    }
  }
  private read(): Ledger {
    const d = JSON.parse(readFileSync(this.file, 'utf8')) as Ledger;
    if (
      d.version !== 1 ||
      d.maxAttempts !== this.maxAttempts ||
      d.maxTokens !== this.maxTokens ||
      !Array.isArray(d.entries) ||
      d.entries.length > d.maxAttempts ||
      d.entries.some(
        (e) =>
          !Number.isSafeInteger(e.reserved) ||
          e.reserved < 1 ||
          typeof e.settled !== 'boolean' ||
          (e.reported !== null &&
            (!Number.isSafeInteger(e.reported) || e.reported < 0)),
      )
    )
      throw Error('PHASE_BUDGET_INVALID');
    return d;
  }
  private write(d: Ledger) {
    writeFileSync(this.file, JSON.stringify(d, null, 2) + '\n', 'utf8');
  }
  private charged(d: Ledger) {
    return d.entries.reduce((n, e) => n + (e.reported ?? e.reserved), 0);
  }
  reserve(tokens: number): number {
    return this.locked(() => {
      const d = this.read();
      if (d.entries.length >= d.maxAttempts)
        throw Error('PHASE_HTTP_ATTEMPT_BUDGET');
      if (this.charged(d) + tokens > d.maxTokens)
        throw Error('PHASE_TOKEN_RESERVATION_BUDGET');
      d.entries.push({ reserved: tokens, reported: null, settled: false });
      this.write(d);
      return d.entries.length - 1;
    });
  }
  settle(index: number, reported: number | null) {
    this.locked(() => {
      const d = this.read(),
        e = d.entries[index];
      if (
        !e ||
        e.settled ||
        (reported !== null && (!Number.isSafeInteger(reported) || reported < 0))
      )
        throw Error('PHASE_SETTLEMENT_INVALID');
      e.settled = true;
      e.reported = reported;
      this.write(d);
    });
  }
  snapshot() {
    return this.locked(() => {
      const d = this.read();
      return {
        maxHttpAttempts: d.maxAttempts,
        actualHttpAttempts: d.entries.length,
        reportedTokens: d.entries.reduce((n, e) => n + (e.reported ?? 0), 0),
        unknownUsageAttempts: d.entries.filter((e) => e.reported === null)
          .length,
        accountedTokens: this.charged(d),
        maxAccountedTokens: d.maxTokens,
      };
    });
  }
}
