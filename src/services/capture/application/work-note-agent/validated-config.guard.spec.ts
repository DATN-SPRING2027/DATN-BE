import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  evaluateValidatedConfig,
  hashProviderPolicy,
  loadValidatedConfigRegistry,
  type ValidatedConfigEntry,
  type ValidatedConfigRegistry,
} from './validated-config.guard';
import {
  ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
  ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
  ASSESSMENT_EDITOR_PROVIDER_POLICY,
} from './work-note-assessment-editor';
import { ASSESSMENT_PROMPT_VERSION } from './work-note-assessment.protocol';
import {
  CANONICAL_ASSESSMENT_INPUT,
  CANONICAL_EDITOR_INPUT,
} from './prompt-fingerprint.fixtures';
import { WorkNoteAgentModel } from '../../infrastructure/ai/work-note-agent.model';
import { WorkNoteXkiroClient } from '../../infrastructure/ai/work-note-xkiro.client';

describe('Validated config guard — warn before PASS, block after PASS (D2 / G3)', () => {
  it.each([
    { NODE_ENV: 'production', WORKNOTE_AGENT_REQUIRE_VALIDATED_CONFIG: false },
    { NODE_ENV: 'staging', WORKNOTE_AGENT_REQUIRE_VALIDATED_CONFIG: true },
  ])(
    'blocks all unvalidated surfaces before provider access for $NODE_ENV',
    async (environment) => {
      const model = new WorkNoteAgentModel(
        new ConfigService({
          ...environment,
          WORKNOTE_AGENT_ENABLED: true,
          XKIRO_API_KEY: 'synthetic-test-key',
          XKIRO_MODEL: 'test/model',
        }),
      );
      model.setValidatedConfigRegistryOverride({
        schemaVersion: 1,
        entries: [],
      });
      const provider = jest
        .spyOn(WorkNoteXkiroClient.prototype, 'complete')
        .mockRejectedValue(new Error('Provider must not be called'));
      expect(() => model.precheckAssessment()).toThrow(
        ServiceUnavailableException,
      );
      expect(() => model.precheck(CANONICAL_EDITOR_INPUT)).toThrow(
        ServiceUnavailableException,
      );
      expect(() =>
        model.precheck(CANONICAL_EDITOR_INPUT, 'assessment'),
      ).toThrow(ServiceUnavailableException);
      await expect(model.assess(CANONICAL_ASSESSMENT_INPUT)).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(
        model.rewrite(CANONICAL_EDITOR_INPUT, 'assessment'),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(provider).not.toHaveBeenCalled();
    },
  );
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads repo validated-configs.json cleanly in warn-only mode while no baseline has passed yet', () => {
    const registry = loadValidatedConfigRegistry();
    expect(registry.schemaVersion).toBe(1);
    expect(Array.isArray(registry.entries)).toBe(true);
  });

  it('allows execution with validatedConfig=false when 0 PASS entries exist for a surface', () => {
    const emptyRegistry: ValidatedConfigRegistry = {
      schemaVersion: 1,
      entries: [],
    };
    const decision = evaluateValidatedConfig(
      {
        surface: 'assessment',
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        model: 'mistralai/ministral-14b',
        architecture: 'combined',
        providerPolicy: ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
      },
      emptyRegistry,
    );
    expect(decision).toEqual({
      allowed: true,
      validatedConfig: false,
      reason: 'NO_PASS_BASELINE_WARN_ONLY',
      providerPolicyHash: hashProviderPolicy(
        ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
      ),
    });
  });

  it('returns validatedConfig=true when >= 1 PASS entry exists and matches surface, promptVersion, model, architecture, and providerPolicyHash', () => {
    const passEntry: ValidatedConfigEntry = {
      surface: 'assessment',
      promptVersion: ASSESSMENT_PROMPT_VERSION,
      manifestHash: 'deadbeef'.repeat(8),
      model: 'mistralai/ministral-14b',
      architecture: 'combined',
      providerPolicy: ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
      providerPolicyHash: hashProviderPolicy(
        ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
      ),
      gateRunId: 'plan-v4-release60-test',
      passedAt: '2026-11-03T02:00:00.000Z',
    };
    const registry: ValidatedConfigRegistry = {
      schemaVersion: 1,
      entries: [passEntry],
    };

    const matched = evaluateValidatedConfig(
      {
        surface: 'assessment',
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        model: 'mistralai/ministral-14b',
        architecture: 'combined',
        providerPolicy: ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
      },
      registry,
      { requireValidatedBaseline: true },
    );
    expect(matched).toEqual({
      allowed: true,
      validatedConfig: true,
      reason: 'MATCHED_VALIDATED_CONFIG',
      providerPolicyHash: passEntry.providerPolicyHash,
      matchedGateRunId: 'plan-v4-release60-test',
    });
  });

  it.each([
    [
      'model',
      {
        model: 'unvalidated/other-model',
      },
    ],
    [
      'promptVersion',
      {
        promptVersion: 'task-note-assessment/2099-01-01.v999',
      },
    ],
    [
      'architecture',
      {
        architecture: 'split' as const,
      },
    ],
    [
      'providerPolicyHash',
      {
        providerPolicy: {
          ...ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
          temperature: 0.7,
        },
      },
    ],
  ])(
    'blocks execution when >= 1 PASS entry exists and %s diverges',
    (expectedField, override) => {
      const passEntry: ValidatedConfigEntry = {
        surface: 'assessment',
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        manifestHash: 'deadbeef'.repeat(8),
        model: 'mistralai/ministral-14b',
        architecture: 'combined',
        providerPolicy: ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
        providerPolicyHash: hashProviderPolicy(
          ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
        ),
        gateRunId: 'plan-v4-release60-test',
        passedAt: '2026-11-03T02:00:00.000Z',
      };
      const decision = evaluateValidatedConfig(
        {
          surface: 'assessment',
          promptVersion: ASSESSMENT_PROMPT_VERSION,
          model: 'mistralai/ministral-14b',
          architecture: 'combined',
          providerPolicy: ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
          ...override,
        },
        { schemaVersion: 1, entries: [passEntry] },
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.mismatchedFields).toContain(expectedField);
      }
    },
  );

  it('WorkNoteAgentModel sets validatedConfig=false before PASS and blocks with WORKNOTE_AGENT_UNAVAILABLE without any HTTP call after PASS mismatch', async () => {
    let activeModel = 'mistralai/ministral-14b';
    const config = {
      get: (key: string) => {
        if (key === 'WORKNOTE_AGENT_ENABLED') return 'true';
        if (key === 'XKIRO_API_KEY') return 'synthetic-test-key';
        if (key === 'XKIRO_MODEL') return activeModel;
        if (key === 'WORKNOTE_ASSESSMENT_ARCHITECTURE') return 'combined';
        if (key === 'WORKNOTE_SECURITY_HMAC_SECRET')
          return 'synthetic-hmac-secret-32-chars-minimum!';
        return undefined;
      },
    } as unknown as ConfigService;

    const completeSpy = jest
      .spyOn(WorkNoteXkiroClient.prototype, 'complete')
      .mockImplementation((messages) => {
        const lastPayload = JSON.parse(messages.at(-1)!.content) as {
          source: { text: string };
        };
        return Promise.resolve({
          content: JSON.stringify({
            status: 'SUGGESTION_READY',
            message: 'Giữ nguyên ghi chú.',
            suggestion: {
              replacementText: lastPayload.source.text,
              suggestedTitle: null,
              changeSummary: [],
            },
            questions: [],
            uncertainties: [],
          }),
          responseId: 'test-resp',
          requestedModel: 'mistralai/ministral-14b',
          reportedModel: 'mistralai/ministral-14b',
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20,
          attempts: 1,
          elapsedMs: 5,
        });
      });

    const modelService = new WorkNoteAgentModel(config);
    modelService.setValidatedConfigRegistryOverride({
      schemaVersion: 1,
      entries: [],
    });

    const warnRun = await modelService.rewrite(
      CANONICAL_EDITOR_INPUT,
      'assessment',
    );
    expect(warnRun.provenance.validatedConfig).toBe(false);
    expect(completeSpy).toHaveBeenCalledTimes(1);

    // Now register a PASS entry for assessment-editor on ministral-14b
    const editorPass: ValidatedConfigEntry = {
      surface: 'assessment-editor',
      promptVersion: ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
      manifestHash: 'abcd1234'.repeat(8),
      model: 'mistralai/ministral-14b',
      architecture: 'single',
      providerPolicy: ASSESSMENT_EDITOR_PROVIDER_POLICY,
      providerPolicyHash: hashProviderPolicy(ASSESSMENT_EDITOR_PROVIDER_POLICY),
      gateRunId: 'gate-pass-1',
      passedAt: '2026-11-03T02:00:00.000Z',
    };
    modelService.setValidatedConfigRegistryOverride({
      schemaVersion: 1,
      entries: [editorPass],
    });

    const passRun = await modelService.rewrite(
      CANONICAL_EDITOR_INPUT,
      'assessment',
    );
    expect(passRun.provenance.validatedConfig).toBe(true);
    expect(completeSpy).toHaveBeenCalledTimes(2);

    // Drift env model -> must reject BEFORE calling WorkNoteXkiroClient.complete and must NOT fallback!
    activeModel = 'drifted/model-v2';
    expect(() =>
      modelService.precheck(CANONICAL_EDITOR_INPUT, 'assessment'),
    ).toThrow(ServiceUnavailableException);
    await expect(
      modelService.rewrite(CANONICAL_EDITOR_INPUT, 'assessment'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(completeSpy).toHaveBeenCalledTimes(2);

    // Also verify assessment surface blocks before HTTP call when PASS exists and model drifted
    modelService.setValidatedConfigRegistryOverride({
      schemaVersion: 1,
      entries: [
        {
          surface: 'assessment',
          promptVersion: ASSESSMENT_PROMPT_VERSION,
          manifestHash: 'abcd1234'.repeat(8),
          model: 'mistralai/ministral-14b',
          architecture: 'combined',
          providerPolicy: ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
          providerPolicyHash: hashProviderPolicy(
            ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
          ),
          gateRunId: 'gate-pass-1',
          passedAt: '2026-11-03T02:00:00.000Z',
        },
      ],
    });
    expect(() => modelService.precheckAssessment()).toThrow(
      ServiceUnavailableException,
    );
    await expect(
      modelService.assess(CANONICAL_ASSESSMENT_INPUT),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(completeSpy).toHaveBeenCalledTimes(2);
  });
});
