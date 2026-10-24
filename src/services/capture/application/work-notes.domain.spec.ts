import {
  assertReviewerCanReview,
  calculateReportPeriod,
  getFrequencyDays,
  nextFrequencyEffectiveAt,
} from './work-notes.domain';

describe('work notes domain rules', () => {
  it.each([
    ['DAILY', 1],
    ['EVERY_3_DAYS', 3],
    ['WEEKLY', 7],
  ] as const)('maps %s to %i days', (frequency, days) => {
    expect(getFrequencyDays(frequency)).toBe(days);
  });

  it('rejects unsupported report frequencies', () => {
    expect(() => getFrequencyDays('BIWEEKLY' as never)).toThrow(
      'Unsupported work report frequency',
    );
  });

  it('calculates half-open UTC reporting periods from their effective boundary', () => {
    const period = calculateReportPeriod(
      new Date('2026-10-01T00:00:00.000Z'),
      'EVERY_3_DAYS',
      new Date('2026-10-05T09:00:00.000Z'),
    );

    expect(period).toEqual({
      periodStart: new Date('2026-10-04T00:00:00.000Z'),
      periodEnd: new Date('2026-10-07T00:00:00.000Z'),
    });
  });

  it('schedules a frequency change at the next current period boundary', () => {
    expect(
      nextFrequencyEffectiveAt(
        new Date('2026-10-01T00:00:00.000Z'),
        'WEEKLY',
        new Date('2026-10-08T12:00:00.000Z'),
      ),
    ).toEqual(new Date('2026-10-15T00:00:00.000Z'));
  });

  it('refuses self review even when the caller has review permission', () => {
    expect(() => assertReviewerCanReview('user-a', 'user-a', true)).toThrow(
      'Authors cannot review their own work',
    );
  });

  it('refuses review without server verified review permission', () => {
    expect(() => assertReviewerCanReview('user-a', 'user-b', false)).toThrow(
      'Project review permission is required',
    );
  });
});
