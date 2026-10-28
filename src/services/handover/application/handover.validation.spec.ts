import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import {
  formatFollowUpEtag,
  formatHandoverEtag,
  parseRequiredIfMatch,
  validateIdempotencyKeyHeader,
  validateNamedContractSchema,
} from './handover.validation';

interface PayloadScenarioCase {
  id: string;
  schema: string;
  valid: boolean;
  payload: unknown;
}

describe('Handover Contract Validation & 21 Payload Oracles', () => {
  const scenariosPath = path.resolve(
    __dirname,
    '../../../../../Document/research-docs/Workspace/contracts/handover-v1.payload-scenarios.json',
  );
  const scenariosDoc = JSON.parse(fs.readFileSync(scenariosPath, 'utf8')) as {
    cases: PayloadScenarioCase[];
  };

  it('loads all 21 payload scenario cases from the workspace contract', () => {
    expect(scenariosDoc.cases).toHaveLength(21);
  });

  for (const scenario of scenariosDoc.cases) {
    it(`oracle [${scenario.id}] (${scenario.schema}) -> valid=${String(scenario.valid)}`, () => {
      if (scenario.valid) {
        expect(() =>
          validateNamedContractSchema(scenario.schema, scenario.payload),
        ).not.toThrow();
      } else {
        expect(() =>
          validateNamedContractSchema(scenario.schema, scenario.payload),
        ).toThrow(BadRequestException);
      }
    });
  }

  it('validates If-Match header: 428 on missing, 400 on malformed, 409 on mismatched resource', () => {
    const id = '111111111111111111111111';
    expect(() => parseRequiredIfMatch(undefined, 'handover', id)).toThrow(
      HttpException,
    );
    try {
      parseRequiredIfMatch('', 'handover', id);
    } catch (err) {
      expect((err as HttpException).getStatus()).toBe(428);
    }

    expect(() => parseRequiredIfMatch('weak/1', 'handover', id)).toThrow(
      BadRequestException,
    );

    expect(() =>
      parseRequiredIfMatch(formatFollowUpEtag(id, 2), 'handover', id),
    ).toThrow(ConflictException);

    expect(
      parseRequiredIfMatch(formatHandoverEtag(id, 5), 'handover', id),
    ).toBe(5);
  });

  it('validates UUIDv4 Idempotency-Key and normalizes to lowercase', () => {
    expect(
      validateIdempotencyKeyHeader('550E8400-E29B-41D4-A716-446655440000'),
    ).toBe('550e8400-e29b-41d4-a716-446655440000');

    expect(() => validateIdempotencyKeyHeader('not-a-uuid')).toThrow(
      BadRequestException,
    );
    expect(() =>
      // UUIDv1 rejected (version nibble 1 instead of 4)
      validateIdempotencyKeyHeader('550e8400-e29b-11d4-a716-446655440000'),
    ).toThrow(BadRequestException);
  });
});
