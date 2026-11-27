import { ConflictException } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';

export const EXPECTED_ORGANIZATION_ID_HEADER = 'x-expected-organization-id';
export const LEGACY_ORGANIZATION_ID_HEADER = 'x-organization-id';

function readHeaderString(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    const trimmed = value[0].trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Harmonizes `x-expected-organization-id` (canonical multi-org header) and
 * `x-organization-id` (legacy header) across Gateway, IAM, Task, AI-Engine,
 * and domain services (SEC-BE-005 / E2E-INT-010).
 * Throws 409 if both are provided with conflicting values.
 */
export function resolveExpectedOrganizationHeader(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): string | undefined {
  const expected = readHeaderString(headers[EXPECTED_ORGANIZATION_ID_HEADER]);
  const legacy = readHeaderString(headers[LEGACY_ORGANIZATION_ID_HEADER]);

  if (expected && legacy && expected.toLowerCase() !== legacy.toLowerCase()) {
    throw new ConflictException({
      code: 'ORGANIZATION_CONTEXT_MISMATCH',
      message: 'Conflicting organization headers supplied.',
    });
  }
  return expected ?? legacy;
}
