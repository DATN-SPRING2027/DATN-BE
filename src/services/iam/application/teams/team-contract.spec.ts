import { HttpException, UnprocessableEntityException } from '@nestjs/common';
import {
  parseIfMatch,
  parseIdempotencyKey,
  parseTeamCreateInput,
  parseTeamLifecycleInput,
  parseTeamListQuery,
  parseTeamUpdateInput,
} from './team-contract';

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 0;
}

function responseOf(error: unknown): unknown {
  return error instanceof HttpException ? error.getResponse() : undefined;
}

describe('Team HTTP contract parsing', () => {
  it('normalizes create name/code and materializes omitted description as null', () => {
    expect(
      parseTeamCreateInput({ name: '  Cafe\u0301  ', code: ' ops-1 ' }),
    ).toEqual({ name: 'Café', code: 'OPS-1', description: null });
  });

  it('preserves explicit null and empty description on create', () => {
    expect(
      parseTeamCreateInput({ name: 'Ops', code: 'OPS', description: null }),
    ).toEqual({ name: 'Ops', code: 'OPS', description: null });
    expect(
      parseTeamCreateInput({ name: 'Ops', code: 'OPS', description: '' }),
    ).toEqual({ name: 'Ops', code: 'OPS', description: '' });
  });

  it.each([
    [
      'extra create field',
      () =>
        parseTeamCreateInput({ name: 'Ops', code: 'OPS', status: 'ACTIVE' }),
    ],
    [
      'empty normalized name',
      () => parseTeamCreateInput({ name: '  ', code: 'OPS' }),
    ],
    [
      'invalid normalized code',
      () => parseTeamCreateInput({ name: 'Ops', code: '1ops' }),
    ],
    [
      'description controls',
      () =>
        parseTeamCreateInput({
          name: 'Ops',
          code: 'OPS',
          description: 'x\u0001',
        }),
    ],
    [
      'description too long by code points',
      () =>
        parseTeamCreateInput({
          name: 'Ops',
          code: 'OPS',
          description: '😀'.repeat(2001),
        }),
    ],
  ])('rejects %s', (_case, parse) => {
    expect(parse).toThrow(UnprocessableEntityException);
  });

  it('counts Unicode code points and permits TAB/LF in descriptions', () => {
    expect(
      parseTeamCreateInput({
        name: '😀'.repeat(200),
        code: 'T1',
        description: '\tline\n',
      }).name,
    ).toBe('😀'.repeat(200));
    expect(
      parseTeamCreateInput({ name: 'Ops', code: 'T1', description: '\tline\n' })
        .description,
    ).toBe('\tline\n');
  });

  it('keeps omitted PATCH fields omitted and lets null clear description', () => {
    expect(parseTeamUpdateInput({ name: ' New ' })).toEqual({ name: 'New' });
    expect(parseTeamUpdateInput({ description: null })).toEqual({
      description: null,
    });
  });

  it.each([
    ['empty patch', {}],
    ['immutable code', { code: 'NEW' }],
    ['unknown property', { name: 'New', projectId: 'a'.repeat(24) }],
    ['null name', { name: null }],
  ])('rejects %s', (_case, body) => {
    expect(() => parseTeamUpdateInput(body)).toThrow(
      UnprocessableEntityException,
    );
  });

  it('trims and validates lifecycle reasons', () => {
    expect(parseTeamLifecycleInput({ reason: '  retired  ' })).toEqual({
      reason: 'retired',
    });
    expect(() => parseTeamLifecycleInput({ reason: 'x\u007f' })).toThrow(
      UnprocessableEntityException,
    );
  });

  it('rejects arrays, injected query keys, invalid status, and unbounded pagination', () => {
    expect(() => parseTeamListQuery({ page: ['1'] })).toThrow(
      UnprocessableEntityException,
    );
    expect(() => parseTeamListQuery({ $where: 'true' })).toThrow(
      UnprocessableEntityException,
    );
    expect(parseTeamListQuery({ status: 'ALL' }).status).toBe('ALL');
    expect(parseTeamListQuery({})).toEqual({
      page: 1,
      pageSize: 20,
      status: 'ACTIVE',
    });
    expect(parseTeamListQuery({ status: 'ARCHIVED' })).toEqual({
      page: 1,
      pageSize: 20,
      status: 'ARCHIVED',
    });
    expect(() => parseTeamListQuery({ pageSize: '101' })).toThrow(
      UnprocessableEntityException,
    );
    expect(() =>
      parseTeamListQuery({ page: '9007199254740991', pageSize: '100' }),
    ).toThrow(UnprocessableEntityException);
  });

  it('requires an ASCII idempotency key of 1–128 allowed characters', () => {
    expect(parseIdempotencyKey('cmd:2026-01')).toBe('cmd:2026-01');
    expect(() => parseIdempotencyKey('é')).toThrow(
      UnprocessableEntityException,
    );
    expect(() => parseIdempotencyKey('x'.repeat(129))).toThrow(
      UnprocessableEntityException,
    );
    try {
      parseIdempotencyKey(undefined);
    } catch (error) {
      expect(statusOf(error)).toBe(422);
      expect(responseOf(error)).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      });
    }
  });

  it('parses one strong resource ETag and maps missing/stale syntax separately', () => {
    expect(
      parseIfMatch(
        '"team:0123456789abcdef01234567:7"',
        '0123456789abcdef01234567',
      ),
    ).toEqual({
      teamId: '0123456789abcdef01234567',
      version: 7,
    });
    expect(() => parseIfMatch(undefined, '0123456789abcdef01234567')).toThrow();
    try {
      parseIfMatch(undefined, '0123456789abcdef01234567');
    } catch (error) {
      expect(statusOf(error)).toBe(428);
    }
    for (const tag of [
      'W/"team:0123456789abcdef01234567:7"',
      '*',
      '"team:0123456789abcdef01234567:7", "team:0123456789abcdef01234567:8"',
      '"team:fedcba9876543210fedcba98:7"',
    ]) {
      expect(() => parseIfMatch(tag, '0123456789abcdef01234567')).toThrow(
        UnprocessableEntityException,
      );
    }
  });
});
