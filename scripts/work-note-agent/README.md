# WorkNote Agent prompt evaluation

This explicit synthetic-only evaluation harness is separate from the guarded
Task Note runtime now registered in Capture/Gateway/FE. The harness never reads
application MongoDB, saves notes, submits reviews, calls SAG or executes tools.
See `docs/work-note-agent/README.md` and DOC contract 04 / delivery record 05
for the runtime, separate DB package and disposable local preview.

## Offline checks

```powershell
npm run test:worknote-agent
npm run eval:worknote-agent -- --dry-run --split all
```

Dry run is the default. It validates the 120 bundled cases and prepares requests
without loading credentials or contacting the network. No dependencies were added.
Use `npm run check` for the required repository checks. The script sources also
need `npx eslint scripts/work-note-agent/*.ts` because the repository lint script
targets src/test only.

## Explicit live evaluation

Set `XKIRO_API_KEY` in the existing BE `.env` or process environment. Never pass
credentials as CLI arguments or commit a populated environment file. Select a
full model ID from the public xKiro catalog; catalog presence does not establish
account entitlement. `XKIRO_MODEL` is an optional local default.

```powershell
npm run eval:worknote-agent -- --live --model mistralai/ministral-14b --case-ids grammar-001,protected-002,task-context-002,selection-007,conversation-003 --max-calls 5 --include-output
npm run eval:worknote-agent -- --live --model mistralai/ministral-14b --split development --max-calls 70 --concurrency 2 --include-output
npm run eval:worknote-agent -- --live --model mistralai/ministral-14b --split validation --max-calls 25 --concurrency 2 --include-output
npm run eval:worknote-agent -- --live --model mistralai/ministral-14b --split holdout --max-calls 25 --concurrency 2 --include-output
```

Options: `--corpus baseline|v2`, `--split development|validation|holdout|all`, `--limit 1..120`,
`--runs 1..3`, `--max-calls 1..360` (default 5), `--concurrency 1..3` (default 1),
`--max-tokens 128..16384` (default 2048), `--timeout-ms 1000..90000` (default
30000), `--reasoning none|low|medium|high`, `--include-output`, and explicit
`--recover-empty-containers`. The latter can add only missing empty arrays;
it cannot alter text/status. Recovery metrics are separate; the exit code still
uses first-pass results. Strict parsing/protection applies after recovery.
The declared max-calls budget counts logical trials. A transient HTTP failure
may cause one additional attempt of that same request. There are no model-based
repair calls and no automatic model fallback.

The client only sends credentials to the fixed HTTPS xKiro Chat Completions
endpoint, with redirects disabled. It requests JSON mode but does not assume
the model enforces it. It does not expose reasoning_content, tools or web search.
It checks finish_reason and rejects truncation. The entire attempt/retry sequence
shares a deadline. It retries only 429/500/502/503 once with identical request
bytes. Ambiguous network failures are not blindly retried. Authentication or
entitlement failures stop that model's batch; three consecutive provider errors
also stop the batch.

## Corpus and evaluation protocol

`cases.json` contains 120 authored synthetic cases: grammar 20, protected content
20, style 15, Task context 20, selection 15, conversation 20 and adversarial input
10. Each category contributes to the fixed 70/25/25 development/validation/holdout
split. Task data, examples, URLs, tokens and identifiers are fictitious.

`cases-v2.json` is a separately authored 42-case corpus with frozen 21/7/14
development/validation/holdout splits. Seven categories exercise language and
uncertainty, technical literals, Task fidelity, selection, necessary clarification,
skipped clarification and unsupported assertions. See DOC record 06 for results,
prompt freeze boundaries and the later v0.3.1 development-only stability run.

Use development failures for prompt iteration. Freeze the prompt before
validation and holdout. Do not tune on the holdout and then present it as an
independent final test. If an oracle needs correction, document the reason and
change its version. A correction to an English grammar case accepts “haven't” as
well as “not”; it is not a requirement to rewrite every negative using one word.

Independent trials receive unique opaque `user` identities, while retries keep
the exact body. This separates real repeated inference from xKiro's short-lived
replay of identical blocking requests. The provider still offers no deterministic
output guarantee. The reported model ID does not independently verify the actual
upstream route.

Reports go into ignored `.worknote-agent-evals/`. They contain counts, token
usage, first-pass JSON/boundary/rule outcomes, successful and attempted latency,
prompt/corpus hashes for new runs, model catalog metadata and failure case IDs.
Public list-price estimates are not actual invoices: discounts and usage from
failed requests may be unknown. `--include-output` additionally saves bounded
synthetic response text and accepted output for developer review; it never saves
reasoning blocks or prompts, and redacts the configured key. These diagnostic
artifacts are permitted only for the bundled synthetic dataset, not real notes.

Exit codes: 0 means every planned case passed automated rules; 1 means an
evaluation failure, provider failure or skipped trial; 2 means configuration or
harness failure. A nonzero evaluation exit is evidence to inspect, not a reason
to change the oracle until the model passes.

## What the scores do and do not prove

JSON syntax, strict branch shapes, exact protected fragments and stale snapshot
checks are separate from semantic quality. Required/forbidden phrase rules are
transparent heuristics and may have false positives. All results retain
`manualReview: required` and `semanticAcceptance: NOT_ESTABLISHED`.
Human review must check preserved meaning/negation/uncertainty, source fidelity,
unnecessary questions, language and useful editing. An automated pass is not an
independent review or production acceptance. No inference is made about ACL or
the correctness of the future runtime from these synthetic tests.

## Reusable prototype boundary

`prepareAgentRequest` accepts bounded internal input after its host has
authorized it. It separates instructions from source data and excludes IDs,
revision, range offsets and hashes from the provider payload. Selection sends at
most 320 UTF-16 code units on either side; full-note context is explicit. Fenced
code, inline code, URLs, marker-like source text and explicit log ranges are
masked and restored exactly. Partial selections inside code use whole-source
protection ranges. Arbitrary unfenced code/log detection is not claimed.

`parseAgentResult` rejects unknown fields, wrong branches, missing/duplicate
protected markers and exact repeats of resolved questions. Semantic paraphrases
of repeated questions are an evaluation concern, not a deterministic guarantee.
It binds suggestions to a server-created ID and exact title/body/revision hash.
`applySuggestion` is a pure draft transform with stale checks and optional title
application; it is not authorization, persistence, autosave, undo storage or a
business state transition. The separate draft service/controller and FE composer
now own authorization, Insert-after, persistence, autosave, undo and explicit Save
under contract 04. The DB branch owns schemas/indexes/migration.

The current actual workflow still owns Task Note confirmation and Project
Document/Work Report review. Task Notes do not automatically enter official SAG
knowledge. The user approved canonical-only Save with original-deletion
confirmation and 24-hour draft/chat expiry. Downstream SAG eligibility/revoke
remain outside the Task Note pilot and require their own verified contract.

## Official references checked 2026-10-27

- https://docs.xkiro.com/api/chat-completions/
- https://docs.xkiro.com/guides/structured-output/
- https://docs.xkiro.com/api/idempotency/
- https://docs.xkiro.com/api/list-models/
- https://docs.xkiro.com/guides/reasoning/
- https://xkiro.com/privacy
- https://platform.claude.com/docs/en/test-and-evaluate/develop-tests

The structured-output guide says enforcement varies by model; a successful HTTP
response does not establish schema compliance. Privacy claims at the gateway do
not establish upstream retention policy or permission to transmit real notes.
