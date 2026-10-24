import {
  validateProjectDocumentInput,
  validateReportFrequency,
  validateReviewInput,
  validateTaskNoteInput,
  validateWorkReportInput,
} from './work-notes.validation';

describe('Work Notes request validation', () => {
  it('accepts explicit empty document text for file drafts but rejects an omitted field', () => {
    const input = { title: 'Architecture', type: 'ARCHITECTURE' };
    expect(() => validateProjectDocumentInput(input)).toThrow();
    expect(
      validateProjectDocumentInput({ ...input, content: '' }).content,
    ).toBe('');
  });
  it('requires all structured Task Note fields and rejects extra fields', () => {
    expect(() =>
      validateTaskNoteInput({
        title: 'Build API',
        accomplishments: 'Added endpoint',
        approach: '',
        reason: 'Validate before write',
      }),
    ).toThrow();
    expect(() =>
      validateTaskNoteInput({
        title: 'Build API',
        accomplishments: 'Added endpoint',
        approach: 'Used Nest',
        reason: 'Validate before write',
        status: 'APPROVED',
      }),
    ).toThrow();
  });

  it('rejects oversized document content and task associations on Project Documents', () => {
    expect(() =>
      validateProjectDocumentInput({
        title: 'Architecture',
        type: 'ARCHITECTURE',
        content: 'x'.repeat(200_001),
      }),
    ).toThrow();
    expect(() =>
      validateProjectDocumentInput({
        title: 'Architecture',
        type: 'ARCHITECTURE',
        content: 'Markdown',
        taskId: '507f1f77bcf86cd799439011',
      }),
    ).toThrow();
  });

  it('requires the three core report fields and supports 1 to 7 day cadences', () => {
    expect(() =>
      validateWorkReportInput({
        accomplishments: 'Shipped feature',
        approach: 'Incremental changes',
        reason: 'Reduce risk',
        cadenceDays: 30,
      }),
    ).toThrow();
    expect(() => validateReportFrequency('EVERY_30_DAYS')).toThrow();
    expect(validateReportFrequency('DAILY')).toBe('DAILY');
    expect(validateReportFrequency('EVERY_2_DAYS')).toBe('EVERY_2_DAYS');
    expect(validateReportFrequency('EVERY_3_DAYS')).toBe('EVERY_3_DAYS');
    expect(validateReportFrequency('EVERY_4_DAYS')).toBe('EVERY_4_DAYS');
    expect(validateReportFrequency('EVERY_5_DAYS')).toBe('EVERY_5_DAYS');
    expect(validateReportFrequency('EVERY_6_DAYS')).toBe('EVERY_6_DAYS');
    expect(validateReportFrequency('WEEKLY')).toBe('WEEKLY');
  });

  it('requires a reason for change requests and rejections', () => {
    expect(() => validateReviewInput({}, true)).toThrow();
    expect(
      validateReviewInput({ comment: 'Please add testing evidence.' }, true),
    ).toEqual({
      comment: 'Please add testing evidence.',
    });
  });
});
