# Synthetic Task Note assessment evaluation v4

This is an evaluation artifact, not a production endpoint or an independent
semantic approval. It reuses the runtime assessment prompt/parser and the
existing xKiro client; it does not read IAM accounts, Task databases or real notes.
The corpus and rubrics are authored synthetic fixtures, not human gold labels.

## Frozen scenario layout

- 72 scenarios in 36 families, two contrastive notes per Task family.
- Splits: 36 development / 12 validation / 24 holdout; no family crosses splits.
- 48 scenarios have one assessment turn, 16 have two, and eight have three.
- Pilot: first six development families, 12 scenarios with 8 single / 3 two /
  1 three-turn scenarios. Thus at most 17 analysis plus 12 Editor calls = 29.
- Full suite ceiling: 104 analysis plus at most 72 Editor calls = 176. Technical
  preflight denial, a required question or early stop can reduce actual calls.

The synthetic adapter supplies question/answer/correction/reset transcripts to the
production state assembler and model protocol. It is not a substitute for IAM,
HTTP/transaction/lease tests or real-user end-to-end acceptance. Runtime API/E2E coverage belongs to the production test suite.

## Default: offline dry run

```powershell
npx ts-node --transpile-only scripts/work-note-agent/assessment-run.ts --dry-run
```

Dry run loads only the bundled corpus and pure prompt helper, prints upper-bound
calls and configured caps, and never reads `.env` or calls a provider.

The implementation agent must not run live evaluation without its authorized
batch/model/attempt/token scope. For an authorized pilot, the operator command is:

```powershell
npx ts-node --transpile-only scripts/work-note-agent/assessment-run.ts --live --phase-id operator-authorized-pilot --model mistralai/ministral-14b --max-attempts 29 --max-total-tokens 500000
```

Live credentials are read server-side from the current BE `.env`; never pass an
API key in arguments or copy it into a report. JSON mode and fixed runtime
temperature are reused. Provider retry is zero in this evaluator. One shared
fetch wrapper counts every actual HTTP attempt across analysis and Editor roles;
the pilot cannot raise its attempt cap above 29. A full run is separately
selected with `--batch full --split all --max-attempts 176` and needs separate
authorization. There is no automatic model fallback or automatic repeat batch.

Token accounting reserves serialized request UTF-8 bytes plus output allowance
and overhead before an attempt, then uses valid provider-reported usage when
available. Failed or unknown usage retains its reservation. This is conservative
local backpressure, not an exact tokenizer, an invoice or a monetary guarantee.
Reported tokens, unknown-usage attempts and accounted reservations stay separate;
cost remains NOT_ESTABLISHED. Set the authorized token cap explicitly. If a
provider reports usage beyond a reservation, future requests stop at the cap;
already consumed provider usage cannot be undone.

## Evidence and review

Live reports and unanswered human worksheets are written only under ignored
`.worknote-agent-evals`, with unique non-overwriting filenames. Console output
contains case IDs, grades, error codes and counters, not prompts/source bodies,
raw responses or credentials. Per-turn synthetic source/answer snapshots remain
in the local review artifact so a reviewer can inspect actual cited passages.
Invalid synthetic model content is captured only in the ignored local report
and review worksheet, with the configured API key redacted if echoed. It is
excluded from console output. This avoids paid repeat calls merely to diagnose
a strict schema failure. No raw provider HTTP error body is exposed.

The operator ledger `assessment-pilot-ledger-2026-10-29.json` records attempts
across tuning/diagnostic batches. It is a manual evidence record, not an automatic
cross-process quota store. Respect the remaining cumulative phase budget when
setting the next batch's `--max-attempts`; never reset to29 after failed calls.

The development phase recorded in that ledger is now closed: 29 actual HTTP
attempts and 73,953 provider-reported tokens were consumed across tuning and
diagnostics. There is no remaining provider budget for this phase. The command
above is a generic interface example, not authorization to start another batch.

## Historical limits of the frozen initial development comparison

The final v5 batch consumed 10 HTTP attempts. Seven assessment turns passed the
automatic checks; two Editor responses passed the strict protocol. A third
Editor response failed `REWRITE_INVALID_OUTPUT`; the next Editor request was
denied locally before HTTP at the attempt cap. These are observations from a
partial development run, not a full pilot pass rate, human semantic approval,
validation/holdout evidence or application end-to-end completion. The development
quality gate remains FAILED and semantic acceptance remains NOT_ESTABLISHED.

The assessment prompt/parser are shared, but the frozen harness Editor input is
not identical to the application Editor input. The harness uses `restructure`
with a shorter purpose instruction and empty history. The assessment service
uses `custom`, includes adequacy in its instruction, and sends up to eight
unresolved assessment gaps as history. Unknown answers are represented as
skipped by the harness but as an answered `Chưa biết` in the service. Task step
completion flags are also synthesized as false by the harness. Consequently,
Editor results cannot be reported as a measured runtime comparison.

The harness records an Editor response after protocol parsing and checks draft
body fidelity when replacement text exists. The service additionally requires
`SUGGESTION_READY` with replacement text and checks each answered clarification
for fidelity. A harness Editor protocol acceptance therefore does not establish
that the runtime would accept the same proposal.

The harness parses Editor output directly with no formatting recovery and uses
zero retries; the final development batch allowed 8,192 output tokens per call.
The production rewrite model allows one retry, uses 4,096 output tokens, and can
perform empty-container formatting recovery when
`WORKNOTE_AGENT_FORMATTING_RECOVERY=true` (the root operator reports it enabled
locally). Recovery is structural and does not establish factual correctness.
This configuration difference may affect acceptance, latency and actual calls;
no direction or magnitude has been measured. The frozen reports are retained
unchanged. Any future parity comparison requires separate authorization and a
new versioned configuration after this phase; do not rerun within the closed
budget.

The grader checks expected context/adequacy branches, question gap kind/topic,
source references and origins, missing-source inventions, controlled prohibited
assertions and repeated declined/resolved targets. These checks are useful but
are not a general entailment model. Parser acceptance and exact quotation do not
prove that a Task requirement was fulfilled. The protocol's conservative FULL
and negative-evidence guards have separate adversarial unit tests.

Keep Save, proposal acceptance, author validation and independent semantic review
as distinct signals. This harness does not fabricate Apply/Save or human ratings.
All review ratings stay null and semanticAcceptance stays NOT_ESTABLISHED.

Freeze corpus hash, system prompt hash, prompt/model/config and parser revision
before validation/holdout. Do not tune on holdout outputs or treat failed provider
attempts as semantic passes. Source fidelity, question usefulness and adequacy
still require the approved human rubric and review process.

## Targeted verification

```powershell
npm test -- --runInBand --runTestsByPath src/services/capture/application/work-note-agent/work-note-assessment.evaluation.spec.ts
```

Tests include the frozen manifest and family splits, default offline behavior,
mocked shared role-call cap, disabled retries, unknown usage reservation,
unresolved semantic worksheets and adversarial source/claim inversions. Live
mode in these tests always uses injected synthetic mocked HTTP and credentials.


## Follow-up prompt-quality phase, explicitly requested by the user

`assessment-prompt-quality-2026-10-29.json` records a separate follow-up phase
requested after the initial29-call phase was closed. It does not overwrite the
initial ledger or reports. The follow-up consumed exactly29 additional HTTP
attempts /111387 reported tokens. No provider budget remains in either phase.

Current analysis is v9 and assessed Editor is v2. Analysis uses five validated
user/assistant examples and a server-owned purpose policy in each request.
Targeted corrections include the prior claim/gap text, not just an opaque ID.
Assessed Editor has a dedicated proposal-only prompt and one example; the
ambiguous `source.wholeNote:null` field is omitted because `source.text` contains
the full body. Ordinary grammar/selection/document/report Editor behavior remains.

Production and evaluation share the Editor input builder, prepared masked request,
strict completion/recovery parser, proposal requirement and uncertainty guards.
Analysis and assessed Editor use shared provider policies:8192/4096 output tokens,
30s timeout, temperature0.1, JSON object mode and zero retries. The formatting
recovery flag is read server-side and recorded. Only a missing question options
array may be added to analysis; no facts, sources, criteria or status are repaired.
Raw and recovered acceptance must stay separate. Excerpt coverage can be backed
by a longer fully sourced author statement, with polarity loss still denied.

Every real live CLI run now needs `--phase-id <operator-authorized-id>`.
The ignored `.worknote-agent-evals/<phase-id>.budget.json` is protected with an
exclusive lock and counts/reserves before every HTTP request across processes.
Unknown/crashed calls retain their reservations; repeated runs cannot reset the
same phase ceiling. A stale lock or corrupt ledger fails closed; never delete a
ledger/lock to recover budget or silently create a new phase. Phase authorization
is an operator/user decision, not a capability granted by this file.

`--cases id1,id2` selects/reorders only cases eligible for the chosen batch/split;
it cannot silently pull holdout cases into a pilot. Always dry-run first. Selected
or repeated development cases are not an independent full-suite pass rate.
`promptTemplateHash` covers the system plus all few-shot messages, not only the
first system message. Reports retain raw synthetic outputs only in ignored local
artifacts with credential redaction, never console or production telemetry.

Follow-up measurements: v9 produced14 analysis attempts;13 parsed and all13 matched
the authored allowed adequacy sets, while full automatic rubric passed only7/14
because gap-kind, relevance/repetition and one requirement extraction failure
remain. Five actual Editor-v2 responses passed the same runtime proposal guards
(across tuning runs; four distinct cases). These are syntax/fidelity observations,
not user Apply/Save, independent semantic review or universal correctness.
Final correction retest passed runtime adequacy after the grounded-excerpt fix;
the model still repeated a gap on its middle turn, which runtime suppressed.
Quality gate remains NOT_PASSED; validation/holdout inference was not performed.
