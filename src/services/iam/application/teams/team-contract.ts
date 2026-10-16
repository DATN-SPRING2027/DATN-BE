import { HttpException, UnprocessableEntityException } from '@nestjs/common';

export type TeamStatus = 'ACTIVE' | 'ARCHIVED';
export type TeamListStatus = TeamStatus | 'ALL';

export interface TeamCreateInput {
  name: string;
  code: string;
  description: string | null;
}

export interface TeamUpdateInput {
  name?: string;
  description?: string | null;
}

export interface TeamLifecycleInput {
  reason: string;
}

export interface TeamListQuery {
  page: number;
  pageSize: number;
  status: TeamListStatus;
}

export interface TeamPrecondition {
  teamId: string;
  version: number;
}

const objectIdPattern = /^[a-f\d]{24}$/i;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function validationFailed(): never {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed.',
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return validationFailed();
  return value as Record<string, unknown>;
}

function hasControls(value: string, allowLayout = false): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x7f ||
      (codePoint < 0x20 &&
        !(allowLayout && (codePoint === 0x09 || codePoint === 0x0a)))
    )
      return true;
  }
  return false;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function normalizedName(value: unknown): string {
  if (typeof value !== 'string') return validationFailed();
  const normalized = value.normalize('NFC').trim();
  const length = codePointLength(normalized);
  if (length < 1 || length > 200 || hasControls(normalized))
    return validationFailed();
  return normalized;
}

function normalizedCode(value: unknown): string {
  if (typeof value !== 'string') return validationFailed();
  const normalized = value
    .trim()
    .replace(/[a-z]/g, (letter) => letter.toUpperCase());
  if (!/^[A-Z][A-Z0-9_-]{1,31}$/.test(normalized)) return validationFailed();
  return normalized;
}

function description(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    codePointLength(value) > 2000 ||
    hasControls(value, true)
  )
    return validationFailed();
  return value;
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    validationFailed();
}

export function isTeamId(value: string): boolean {
  return objectIdPattern.test(value);
}

export function parseTeamCreateInput(value: unknown): TeamCreateInput {
  const body = record(value);
  strictKeys(body, ['name', 'code', 'description']);
  if (!Object.hasOwn(body, 'name') || !Object.hasOwn(body, 'code'))
    return validationFailed();
  return {
    name: normalizedName(body.name),
    code: normalizedCode(body.code),
    description:
      body.description === undefined ? null : description(body.description),
  };
}

export function parseTeamUpdateInput(value: unknown): TeamUpdateInput {
  const body = record(value);
  strictKeys(body, ['name', 'description']);
  if (Object.keys(body).length === 0) return validationFailed();
  const input: TeamUpdateInput = {};
  if (Object.hasOwn(body, 'name')) input.name = normalizedName(body.name);
  if (Object.hasOwn(body, 'description'))
    input.description = description(body.description);
  return input;
}

export function parseTeamLifecycleInput(value: unknown): TeamLifecycleInput {
  const body = record(value);
  strictKeys(body, ['reason']);
  if (typeof body.reason !== 'string') return validationFailed();
  const reason = body.reason.trim();
  const length = codePointLength(reason);
  if (length < 1 || length > 500 || hasControls(reason))
    return validationFailed();
  return { reason };
}

function positiveInteger(
  value: unknown,
  fallback: number,
  max?: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    return validationFailed();
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    (max !== undefined && parsed > max)
  )
    return validationFailed();
  return parsed;
}

export function parseTeamListQuery(value: unknown): TeamListQuery {
  const query = record(value);
  strictKeys(query, ['page', 'pageSize', 'status']);
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' ||
      !['ACTIVE', 'ARCHIVED', 'ALL'].includes(query.status))
  )
    return validationFailed();
  const page = positiveInteger(query.page, 1);
  const pageSize = positiveInteger(query.pageSize, 20, 100);
  if (!Number.isSafeInteger((page - 1) * pageSize)) return validationFailed();
  return {
    page,
    pageSize,
    status: (query.status as TeamListStatus | undefined) ?? 'ACTIVE',
  };
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.length === 0)
    throw new UnprocessableEntityException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key is required.',
    });
  if (!idempotencyKeyPattern.test(value)) return validationFailed();
  return value;
}

export function parseIfMatch(
  value: string | undefined,
  expectedTeamId: string,
): TeamPrecondition {
  if (value === undefined)
    throw new HttpException(
      { code: 'PRECONDITION_REQUIRED', message: 'If-Match is required.' },
      428,
    );
  const match = /^"team:([a-f\d]{24}):([1-9]\d*)"$/i.exec(value);
  if (!match) return validationFailed();
  const teamId = match[1].toLowerCase();
  const version = Number(match[2]);
  if (
    teamId !== expectedTeamId.toLowerCase() ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    return validationFailed();
  return { teamId, version };
}
