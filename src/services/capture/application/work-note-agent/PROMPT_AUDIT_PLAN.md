# Plan kiểm tra & chống lỗi thời Prompt — Work Note Agent (v4)

> **Lịch sử bản:** v1 (2026-11-02) bỏ sót hạ tầng eval, nhiều khẳng định sai. v2 sửa v1. v3 thêm kết quả đo v25.
> **v4 (2026-11-03 01:2x)**: kết quả cuối holdout 40/40 + **các quyết định đã chốt (mục G)**, chuyển thành đặc tả
> kỹ thuật (mục D) và kế hoạch (mục E). Chỗ quyết định va chạm với ràng buộc code hiện tại được ghi ở **G-xung đột**.
> Số liệu đã đối chiếu với code/file kết quả; giả thuyết được ghi rõ là *giả thuyết*.

---

## 0. Tóm tắt

1. **Baseline v25 đã đo xong (Phương án B), không đạt gate.** Phase `plan-v3-release60-v25-20261103`, manifest 14 file `2a252f2d…`.
   - Validation 20/20: **100%** mọi chỉ số (nhưng validation đã được dùng để chỉnh prompt qua nhiều vòng → không phải ước lượng độc lập).
   - Holdout 40/40: **FAIL** — critical error `falseSufficient` 2 (raw) / 1 (runtime), adequacy macro-F1 0.856 / 0.845, answer usage runtime 16/18.
   - Gộp 60 ca: **FAIL** — chỉ còn critical errors và answer usage runtime 26/28 (92,9%) trượt.
2. **7 lỗi trên holdout (L1–L7) thuộc 3 loại:** model vi phạm prompt và guard bắt đúng (L1, L2, L5, L6); model sai và guard **không** bắt (L3 QA `falseSufficient`, L4 bỏ sót `CONTRADICTORY`); khe hở contract prompt↔parser (L7 `changeSummary: []`).
3. **Đã chốt hướng xử lý:** sửa bằng **parser tất định** cho F15 (claim là đoạn con liên tục) và F17 (`changeSummary` rỗng chỉ khi không đổi nội dung); `validated-configs` cảnh báo trước PASS, chặn sau PASS; corpus mới ≥ 12 `CONTRADICTORY`; `history.conflict` là BLOCKING hợp lệ cho PROGRESS; Document/Report đo trước, chưa có policy riêng.
4. **Ba điểm cần lưu ý trước khi làm** (chi tiết G-xung đột): quy tắc đoạn con **không sửa được hết L1**; corpus release hiện **cấm nguồn HISTORY** nên các tình huống Task cha/con/thông tin bị thay thế không đưa vào được nếu không đổi validator; và theo hợp đồng hiện tại, Task cha/con và SUPERSEDED **không được** cho ra `CONTRADICTORY`.
5. **Việc làm được ngay, không tốn quota:** fingerprint guard, sửa docs, chế độ cảnh báo `validated-configs`, hai thay đổi parser + adversarial test + **replay offline trên 88 lượt raw output đã lưu của v25**, viết corpus mới. Đo lại cần phase mới (phase v25 còn 6/148 attempt).

---

## A. Hiện trạng thực tế

### A1. Kiến trúc runtime — workflow nào dùng prompt nào

| Luồng | Entry | Prompt thực sự gửi | Ghi chú |
|---|---|---|---|
| Rewrite Task Note | `work-note-agent-drafts.service.ts` → `model.rewrite(input)` (mode `editor`) → `prepareAgentRequest` | `SYSTEM_PROMPT` + `OPERATION_POLICY[op]` + 5 `FEW_SHOTS` (+ `HISTORY_POLICY` nếu có `historicalContext`) | transport retries = 1 |
| Rewrite PROJECT_DOCUMENT / WORK_REPORT | `WorkNoteEditorService` (kế thừa drafts service) → cùng đường trên | **Cùng `SYSTEM_PROMPT` rewrite**; prompt không nhắc workflow; 5 few-shot đều là Task Note | flag `WORKNOTE_SHARED_EDITOR_ENABLED`; **không đi qua assessment** |
| Assessment (mặc định) | `model.assess` → `executeAssessmentModelCall` (combined) | `assessmentSystemPrompt(purpose)` + **4 ví dụ** (`selectAssessmentExamples`) + payload | `WORKNOTE_ASSESSMENT_ARCHITECTURE` ≠ `split` |
| Assessment (split) | cùng entry, `architecture = split` | Interpreter + 3 ví dụ (cache theo Task); Assessor + 4 ví dụ | Không nằm trong release gate |
| Assessment Editor | `model.rewrite(input, 'assessment')` → `prepareAssessmentEditorRequest` | `ASSESSMENT_EDITOR_SYSTEM_PROMPT` + 1 ví dụ; **chỉ TASK_NOTE / whole_note / custom** | transport retries = 0 |

Mọi request đi qua `WorkNoteLlmSecurityGateway`. `retries` của `WorkNoteXkiroClient` **chỉ là retry tầng HTTP** (429/500/502/503), không retry khi parser từ chối output.

### A2. Inventory prompt (đã đo)

| # | File | Thành phần | Phiên bản | Kích thước |
|---|---|---|---|---|
| 1 | `work-note-agent.prompt.ts` | `SYSTEM_PROMPT` | `worknote-rewrite/2026-10-27.v0.3.2` | 5.683 ký tự / ~980 từ |
| 2 | ″ | `HISTORY_POLICY` | `history.v2` | 1.417 ký tự |
| 3 | ″ | `OPERATION_POLICY` (8), `FEW_SHOTS` (5) | theo `PROMPT_VERSION` | — |
| 4 | `work-note-assessment.prompt.ts` | `assessmentSystemPrompt(purpose)` | `task-note-assessment/2026-11-02.v25` | ~11.7K ký tự / ~1.910 từ |
| 5 | ″ | `ASSESSMENT_OUTPUT_CONTRACT`, `ASSESSMENT_EXAMPLES` | ″ | 25 ví dụ, gửi 4/request |
| 6 | `work-note-assessment.rubric.ts` | `PURPOSE_RUBRIC_TABLE`, 14 `ASSESSMENT_NEED_CODES` | ″ | — |
| 7 | `work-note-assessment-split.ts` | Interpreter / Assessor | `…interpreter/2026-10-29.v1`, `…assessor/2026-11-02.v2` | 1,3K / 4,3K ký tự |
| 8 | `work-note-assessment-editor.ts` | `ASSESSMENT_EDITOR_SYSTEM_PROMPT` + 1 ví dụ | `task-note-editor/2026-10-29.v4` | 2.454 ký tự |

Bề mặt prompt còn gồm code dựng payload (`context.ts`, `work-note-agent.ts`, `protection.ts`) và provider policy (temperature 0.1, JSON mode, maxTokens 8192/4096, timeout 85s/60s).

### A3. Hạ tầng eval đã có

| Thành phần | Vị trí | Ghi chú |
|---|---|---|
| Corpus rewrite | `cases.json` (120), `cases-v2.json` (42) | **0 case PROJECT_DOCUMENT/WORK_REPORT**; harness `run.ts`/`evaluation.ts` **không có trường workflow** |
| Corpus assessment | `cases-assessment-v4.json` (72), `cases-assessment-v5-release.json` (60: 20 val / 40 holdout) | Validator release **chỉ nhận nguồn TASK/NOTE/ANSWER** (`assessment-quality-gate.ts` L137) và đúng hình dạng 60/20/40/30 family/40-12-8 lượt (L92, L183–187) |
| Quality gate | `assessment-quality-gate.ts` | sourceRef 1.0, critical 0, macro-F1 ≥ 0.9, question P/R ≥ 0.9, answer usage ≥ 0.95, format ≥ 0.98; đo raw và runtime |
| Freeze manifest | `assessment-release-gate-run.ts` | **Đã mở rộng 9 → 14 file** (thay đổi chưa commit) |
| Raw output đã lưu | `.worknote-agent-evals/…v25-20261103.{validation,holdout}-rows.json` | Mọi lượt analysis/Editor có `rawSyntheticResponse` + `sources` + `answers` → **đủ để replay offline** |
| Replay offline | `assessment-replay.ts` | Hiện viết cho corpus cross-domain; cần bản cho release60 |
| Human review | `…v25-20261103.blinded-worksheet.json` + `sealed-key.json` | Đã sinh, chưa review |
| Spec | 27 file `*.spec.ts` | |

### A4. Kết quả đo v25 (2026-11-03)

**Cấu hình:** prompt v25, Editor v4, `mistralai/ministral-14b`, `combined`, retries 0, manifest `2a252f2de53d2add0e2807f3f2ca5937b83cc1d8631df5bd6b8138849f6682bb`.
**Chi phí:** 142/148 HTTP, 1.108.718 reported tokens (accounted 1.223.287), 3 unknown-usage. **Phase còn 6 attempt** → đo tiếp cần phase mới.
**Tham chiếu chi phí:** 1 lần chạy đủ 60 ca ≈ 142 HTTP / 1,1M token ≈ hơn 1 ngày quota free (~500K token/ngày/key).

| Chỉ số | Ngưỡng | Validation 20 ca | Holdout 40 ca (raw / runtime) | Gộp 60 ca (raw / runtime) |
|---|---|---|---|---|
| Source ref | 100% | 176/176 | 322/322 | 498/498 |
| Critical (`falseSufficient`) | 0 | 0 | **2 / 1** ❌ | **2 / 1** ❌ |
| Adequacy macro-F1 | ≥ 0.90 | 1.000 | **0.856 / 0.845** ❌ | 0.912 / 0.904 ✅ |
| — `CONTRADICTORY` (n) | | tp1 (n=1) | tp1 **fn1** (n=2) | tp2 fn1 (n=3) |
| Question P / R | ≥ 0.90 | 1.000 / 1.000 | 0.933 / 0.933 | 0.955 / 0.955 |
| Answer usage | ≥ 0.95 | 10/10 | 18/18 / **16/18** ❌ | 28/28 / **26/28** ❌ |
| First-pass format | ≥ 0.98 | 30/30 | 58/58 | 88/88 |
| Editor | — | 17/17 | 31/33 | 48/50 |
| **Gate** | | PASS | **FAILED** | **FAILED** |

Ghi chú: báo cáo trung gian lúc 36/40 từng ghi question recall 0.857 và format 96,3% là FAIL. Đó là do 2 lượt lỗi 429 bị tính là lỗi mô hình (F19). Số liệu cuối ở bảng trên đã đầy đủ 40/40, không còn lượt 429.

### A5. Phân tích từng ca lỗi trên Holdout (đã đọc output thô, đối chiếu `state.ts`/`protocol.ts`)

> **Kỷ luật eval:** dùng để nhận diện nhóm lỗi; **không** đưa câu chữ/nội dung các ca này vào prompt, few-shot hay oracle.

| # | Ca (turn) | Quan sát | Cơ chế đã kiểm chứng | Loại |
|---|---|---|---|---|
| L1 | `row-level-isolation-b` (t3, COMPLETION, `correct`) | Raw `ENOUGH`; 2 claim đều `PARTIAL` → runtime `UNDETERMINED` | `protocol.ts` L302–308 hạ FULL→PARTIAL khi `claim.text ≠ quote`; L385–396 hạ coverage; `state.ts` L665–678 yêu cầu **mọi** claim không-history là FULL; L688–695 COMPLETION cần mọi coverage SUPPORTED. **Claim 1 chép từ answer lượt 2 nhưng trích quote lượt 3** (không phải đoạn con); claim 2 là đoạn con | Model vi phạm prompt (một phần là cắt câu ghép, một phần là **trích sai nguồn**); guard đúng thiết kế |
| L2 | `incident-postmortem-guide-b` (t3, `reset` HANDOVER→PROGRESS) | `ENOUGH` + `nextQuestion:null` + còn 1 gap BLOCKING | `state.ts` L657–672 | Model tự mâu thuẫn; guard đúng |
| L3 | `reranker-latency-cutoff-b` (t1, QA) | Note chỉ "đã chạy thử kịch bản…", không có kết quả. Model `ENOUGH`, không hỏi | Không guard nào bắt | **Lỗi nghiêm trọng, lọt guard.** *Giả thuyết:* quy tắc QA "TUYỆT ĐỐI KHÔNG đòi kiểm thử phần khác" làm model nghiêng về ENOUGH |
| L4 | `sla-holiday-calendar-b` (t1, COMPLETION) | Note báo kết quả ngược yêu cầu Task. Model `NEEDS_AUTHOR_INPUT` + hỏi thay vì `CONTRADICTORY` | Raw và runtime cùng sai | Lỗi model; mẫu `CONTRADICTORY` quá ít |
| L5 | `composite-index-backfill-b` (t2, `unknown`, PROGRESS) | Raw `ENOUGH` sau khi tác giả trả "không biết" | `state.ts` L679–686 chặn → runtime `UNDETERMINED` | Lỗi model raw; guard bắt |
| L6 | `pii-redaction-pipeline-a` (Editor) | `REWRITE_PROTECTED_CONTENT_CHANGED`: model giải mã marker thành `**customer_hash**`, nhắc marker trong `changeSummary`, đổi "lẫn"→"và" | Guard marker bắt đúng | Model vi phạm 3 quy tắc prompt |
| L7 | `openapi-deprecation-notice-b` (Editor, OTHER) | `REWRITE_INVALID_OUTPUT`: `replacementText` giữ nguyên, **`changeSummary: []`** | `work-note-agent.ts` L424–425 từ chối summary rỗng; prompt cho phép "giữ nguyên" nhưng không nói summary phải ≥ 1 | **Khe hở contract** |

Ánh xạ chỉ số: answer usage runtime 2 lỗi = L1 + L2; `CONTRADICTORY fn1` = L4; `falseSufficient` runtime = L3, raw = L3 + L5; Editor 2 lỗi = L6 + L7.

---

## B. Đánh giá bao quát

### B1. Đã bao quát tốt (giữ nguyên)

Nguồn & sự thật; giữ phủ định/điều kiện; marker (guard bắt đúng L6); ranh giới chỉ dẫn; clarification không hỏi lặp; 7 purpose + AUTO, 14 need code; history untrusted; output contract nghiêm ngặt (sourceRef 498/498); **fail-safe về `UNDETERMINED`** (đúng ở L1, L2, L5); security gateway.

### B2. Phát hiện

Mức độ: 🔴 cao · 🟠 trung bình · 🟢 thấp · ⚪ giả thuyết.

| # | Phát hiện | Mức | Trạng thái → hướng xử lý |
|---|---|---|---|
| F1 | Bằng chứng gate thuộc v24, runtime chạy v25 | — | ✅ **Đã xử lý:** v25 đã đo đủ 60 ca (FAILED) |
| F2 | History không có case trong release corpus; validator release **cấm nguồn HISTORY** | 🔴 | D4: corpus history riêng + nới validator/harness (G-xung đột X2) |
| F3 | Không có chốt chặn "sửa prompt quên bump version" | 🔴 | D1 |
| F4 | Runtime không đối chiếu model/config với bản đã validate | 🔴 | D2 (quyết định G3) |
| F5 | Manifest thiếu file ảnh hưởng hành vi | 🟠 | Đã thêm 5 file; còn `assessment-split.ts`, `security/*.ts` |
| F6 | Rubric lặp 3 nơi, lệch nhau ở PROGRESS | 🟠 | D3 (quyết định G6) |
| F7 | Rewrite không có policy theo workflow; corpus và harness không có Document/Report | 🟠 | D11 (quyết định G7) |
| F8 | Docs/comment lệch code (README 30s/v9/v2; comment "12" need code) | 🟠 | D7 |
| F9 | Feedback người dùng không quay lại eval | 🟠 | D6 |
| F10 | Split chưa có gate riêng | 🟢 | Giai đoạn sau |
| F11 | Editor nhận ít ngữ cảnh lý do assessment | 🟢 | Giai đoạn sau |
| F12 | Bounds output hardcode | 🟢 | — |
| F13 | Prompt dài, rule-heavy có thể khiến model 14B bỏ quy tắc | ⚪ | Bằng chứng gián tiếp: L1, L5, L6 vi phạm quy tắc đã ghi rõ |
| F14 | `falseSufficient` lọt guard ở QA (L3) | 🔴 | B5 — siết điều kiện ĐỦ của QA trong rubric |
| F15 | Claim cắt câu ghép / trích sai nguồn → kết quả đúng bị hạ `UNDETERMINED` (L1) | 🟠 | D10a parser (quyết định G2) — **chỉ xử lý phần cắt câu ghép** |
| F16 | `ENOUGH` kèm gap BLOCKING khi reset purpose (L2) | 🟠 | B4 |
| F17 | Editor `changeSummary: []` khi giữ nguyên nội dung (L7) | 🟠 | D10b parser (quyết định G4) |
| F18 | Chỉ 3 lượt `CONTRADICTORY` trong 60 ca; 1 lỗi làm macro-F1 tụt ~0,11 | 🟠 | D4 corpus v6 ≥ 12 (quyết định G5) |
| F19 | `stageGate` trung gian tính lượt 429 như lỗi mô hình | 🟠 | D9 |
| F20 | Validation đã bị tune qua nhiều vòng, không còn độc lập; holdout v25 cũng hết độc lập khi đã xem lỗi | 🟠 | D4: holdout v6 viết **trước** khi sửa prompt |
| F21 | Editor lỗi 2/33 trên holdout so với 0/17 validation | 🟠 | Theo dõi trên corpus editor-nochange |
| F22 | Chạy 1 lần/ca, không đo phương sai | ⚪ | Chấp nhận theo G5 (không chạy lặp mặc định) |

---

## C. Vì sao prompt chắc chắn lỗi thời — áp vào repo này

| Vector | Biểu hiện |
|---|---|
| Code đổi, bằng chứng không đổi | F1 (v24→v25), F5 |
| Tính năng mới không có case | F2, F7 |
| Model/provider đổi | F4 |
| Quy tắc nghiệp vụ đổi, prompt viết tay không theo kịp | F6, F8 |
| Lỗi chỉ thấy ở người dùng thật | F9 |
| Tập đo bị dùng cạn | F20 |
| Prompt dài, quy tắc cạnh tranh nhau | F13–F16 |

Nguyên tắc: **không giữ được prompt luôn đúng; chỉ làm cho việc lệch bị phát hiện ngay, đánh giá lại có giới hạn chi phí, và có tập đo mới khi tập cũ đã dùng.** Ưu tiên kiểm tra tất định ở parser/server cho những gì kiểm được (quyết định G2, G4, G6).

---

## D. Đặc tả cơ chế

### D1. Fingerprint guard (F3, F5)

Dựng request template thật trên bộ input chuẩn cố định (synthetic), băm messages trừ message cuối (như `requestTemplateHash`), lưu `prompt-fingerprints.json` theo version.

```typescript
// work-note-prompt-fingerprint.spec.ts (phác thảo)
import fingerprints from './prompt-fingerprints.json';
import { assessmentHash, buildAssessmentMessages, ASSESSMENT_PROMPT_VERSION } from './work-note-assessment.protocol';
import { ASSESSMENT_PURPOSES } from './work-note-assessment.types';
import { prepareAgentRequest } from './work-note-agent';
import { prepareAssessmentEditorRequest, ASSESSMENT_EDITOR_INSTRUCTION_VERSION } from './work-note-assessment-editor';
import { CANONICAL_ASSESSMENT_INPUT, CANONICAL_REWRITE_INPUTS, CANONICAL_EDITOR_INPUT } from './prompt-fingerprint.fixtures';

const surfaces = (): Record<string, string> => ({
  [ASSESSMENT_PROMPT_VERSION]: assessmentHash(
    ASSESSMENT_PURPOSES.map((purpose) =>
      buildAssessmentMessages({ ...CANONICAL_ASSESSMENT_INPUT, purpose }).slice(0, -1),
    ),
  ),
  ...Object.fromEntries(
    CANONICAL_REWRITE_INPUTS.map((input) => {
      const p = prepareAgentRequest(input);
      return [`${p.promptVersion}#${input.operation}`, assessmentHash(p.messages.slice(0, -1))];
    }),
  ),
  [ASSESSMENT_EDITOR_INSTRUCTION_VERSION]: assessmentHash(
    prepareAssessmentEditorRequest(CANONICAL_EDITOR_INPUT).messages.slice(0, -1),
  ),
});

it.each(Object.entries(surfaces()))('prompt surface %s khớp fingerprint đã ghi', (version, hash) => {
  expect((fingerprints as Record<string, string>)[version]).toBe(hash);
});
```

Chỉ cập nhật fixture trong cùng commit bump version, kèm lý do.

### D2. Validated config — **cảnh báo trước PASS, chặn sau PASS** (F4; quyết định G3)

**Nguồn sự thật:** `validated-configs.json` (commit vào repo), mỗi entry chỉ được ghi khi gate **PASS** (automated gate + blinded review theo quy trình hiện có):
`{ surface: 'assessment'|'rewrite'|'assessment-editor', promptVersion, manifestHash, model, architecture, providerPolicy, gateRunId, passedAt }`.

**Khóa so khớp** (định nghĩa chính xác): `surface` + `promptVersion` + `model` + `architecture` + băm chuẩn hóa của `providerPolicy` (maxTokens, timeoutMs, jsonMode, temperature, retries). So sánh **bằng nhau tuyệt đối**, không gần đúng.

| Trạng thái của `surface` | Config hiện tại khớp entry PASS | Hành vi runtime |
|---|---|---|
| Chưa có entry PASS nào | — | **Cho chạy**, ghi `validatedConfig:false` vào provenance/trace, log cảnh báo rõ ràng (mỗi lần khởi động + mỗi lần gọi có rate-limit log) |
| Đã có ≥ 1 entry PASS | Có | Cho chạy, `validatedConfig:true` |
| Đã có ≥ 1 entry PASS | **Không** | **Không kích hoạt:** trả `WORKNOTE_AGENT_UNAVAILABLE` (người dùng vẫn lưu note), log lỗi nêu khóa lệch. **Không tự fallback** sang config khác |

**"Giữ phiên bản PASS gần nhất"** được hiện thực ở **tầng triển khai**, vì prompt là hằng số trong code (bản build chỉ chứa một phiên bản prompt):
- Pipeline release kiểm tra config của bản build mới có entry PASS → nếu không, **chặn triển khai**, bản đang chạy (đã PASS) giữ nguyên.
- Đổi biến môi trường (ví dụ `XKIRO_MODEL`) không qua build → runtime phát hiện lệch → agent ngừng (bảng trên) cho tới khi khôi phục giá trị đã PASS. Runtime **không** tự chọn model từ entry PASS (vì như vậy là âm thầm đổi hành vi).

**Hiện trạng:** chưa có phiên bản nào PASS (v24 chỉ validation, v25 FAILED) → hệ thống ở **chế độ cảnh báo**. Chế độ chặn tự bật khi entry PASS đầu tiên được ghi.

### D3. Rubric một nguồn; `history.conflict` BLOCKING cho PROGRESS (F6; quyết định G6)

**Nguồn quyết định cuối cùng:** `PURPOSE_RUBRIC_TABLE` + server validation (`protocol.ts`/`state.ts`). Prompt **sinh từ table**, không viết tay song song.

Quy tắc cho PROGRESS (và áp tương tự cho các purpose có `history.conflict` trong `allowedBlockingNeeds`):

| Quy tắc (theo quyết định) | Hiện trạng code | Việc cần làm |
|---|---|---|
| `history.conflict` là BLOCKING được phép | Table: **có**. Prompt `ASSESSMENT_SYSTEM_PROMPT`: ghi "CHỈ gồm scope.completed_part và contradiction.conflict" | Sửa prompt (sinh từ table) |
| Chỉ BLOCKING khi **mâu thuẫn thực sự cùng target** | Parser yêu cầu có history ref, và (fact `CONFLICT_*` **hoặc** có nguồn hiện tại NOTE/ANSWER/TASK). **Không có kiểm tra "cùng target"** | Thêm kiểm tra server: gap `history.conflict` BLOCKING phải có **cả** nguồn hiện tại (NOTE/ANSWER) **và** history SELF mà fact `CONFLICT_*`. *Cách xác định "cùng target" một cách tất định cần thiết kế* (ví dụ dựa vào `factStatus CONFLICT_*` do bộ trích history đã gắn) |
| **Không** BLOCKING chỉ vì note cũ khác Task cha/con hoặc khác phạm vi | Parser **cho phép** `history.conflict` từ PARENT/CHILD/LINKED **nếu `factKind = DECISION`** (`protocol.ts` L432–439) | **Cần chốt** (G-mở O3): giữ ngoại lệ DECISION hay bỏ |
| Phân biệt `CONTRADICTORY` / `OUTDATED` / `SUPERSEDED` | Parser cấm `CONTRADICTION` có history ref (L427–429); OUTDATED/SUPERSEDED → `history.outdated` OPTIONAL | Giữ; thêm test |
| Không kết luận tiến độ từ history chưa xác nhận | `HISTORY_IS_NOT_CURRENT_EVIDENCE` (coverage, ENOUGH chỉ từ history) | Giữ; thêm test |
| Mâu thuẫn chưa giải quyết → phải hỏi làm rõ, không được ENOUGH | `state.ts`: ENOUGH + BLOCKING → `UNDETERMINED` (không hỏi) | Thêm: khi còn `history.conflict` BLOCKING chưa trả lời ở lượt đầu → `nextQuestion` phải trỏ tới gap đó (nếu model không hỏi → server không được nâng lên ENOUGH; chấp nhận `UNDETERMINED` thay vì tự bịa câu hỏi) |

Test bắt buộc: (a) mọi need code xuất hiện trong text prompt của purpose ∈ `allowedBlockingNeeds`; (b) các ca trên ở dạng unit test protocol/state. Đổi prompt → bump version → nhóm "text prompt" ở D5.

### D4. Corpus mới (F2, F7, F18, F20; quyết định G5)

**Bất biến:** `cases-assessment-v5-release.json` (40 ca holdout baseline v25) **giữ nguyên, không sửa**.

| Corpus | Nội dung | Ràng buộc |
|---|---|---|
| `cases-assessment-v6-release.json` | Family mới hoàn toàn; **≥ 12 lượt `CONTRADICTORY`** phân bổ: phủ định, đảo trạng thái hoàn thành, xung đột thời gian, kết quả test trái tiêu chí; kèm **cặp đối chứng** (trông giống mâu thuẫn nhưng expected ≠ `CONTRADICTORY`) | Viết **trước** khi sửa prompt, không xem output v25/v26 trên corpus này trước khi freeze. Nằm vừa hình dạng 60 ca hiện tại (validator) hoặc nới validator trước khi freeze v26 |
| `cases-assessment-history-v1.json` | Task cha/con, thông tin bị thay thế (SUPERSEDED/OUTDATED), `history.conflict` SELF thật, chỉ dẫn độc hại trong history, placeholder `[[WN_SEC:…]]` | Validator release hiện **cấm HISTORY** → cần validator/harness riêng (G-xung đột X2) |
| `cases-rewrite-workflows-v1.json` | PROJECT_DOCUMENT, WORK_REPORT × 8 operation | Harness rewrite hiện **không có trường workflow** → cần thêm (D11) |
| `cases-editor-nochange-v1.json` | Editor với note đã đúng (giữ nguyên), note dày số/identifier/marker | Bắt F17, L6 |
| Case development tái hiện L1–L7 | Viết bằng câu chữ khác, **xác nhận fail trên v25** trước khi sửa | Dùng để lặp khi sửa prompt |

**Quy tắc chạy lại (G5):**

| Loại thay đổi | Chạy lại gì | Ghi chú kỷ luật |
|---|---|---|
| Parser/guard tất định | **Replay offline toàn bộ 88 lượt v25** (miễn phí) + case development liên quan | Replay trên dữ liệu đã thấy là **kiểm hồi quy**, không phải ước lượng độc lập |
| Prompt nhỏ (một quy tắc) | **Case development liên quan** (live, phase được duyệt) | **Không** chạy lại "ca holdout liên quan" — làm vậy là tune trên holdout (xem G-xung đột X4) |
| Logic cốt lõi, rubric, cấu trúc nguồn | **Toàn bộ** validation + holdout v6 **một lượt** sau khi freeze | Chạy lại holdout đã dùng chỉ được báo cáo là "hồi quy trên holdout đã thấy" |
| Không chạy lặp mặc định | `--runs 1` | Chạy lặp chỉ bật thủ công trên tập con nhỏ |

### D5. Ma trận "thay đổi gì → đánh giá lại gì"

| Loại thay đổi | Ví dụ file | Trước khi merge | Trước khi bật cho người dùng |
|---|---|---|---|
| Text prompt / few-shot / rubric | `*.prompt.ts`, `rubric.ts`, `assessment-split.ts`, `assessment-editor.ts` | Bump version, fingerprint, unit test, dry-run, development live | Freeze manifest mới + validation + **holdout chưa thấy** PASS + blinded review → ghi `validated-configs` |
| Code dựng payload | `context.ts`, `pipeline.ts`, `work-note-agent.ts`, `protection.ts` | Như dòng trên | Như dòng trên |
| Parser / guard | `protocol.ts`, `polarity.ts`, `state.ts`, `work-note-agent.ts` (parseAgentResult) | Unit + adversarial test + **replay offline 88 lượt v25**: không tăng critical errors | Thay đổi kết quả chấp nhận → gate lại |
| Model / provider policy | `.env`, `*_PROVIDER_POLICY` | — | Gate trên config mới (D2 sẽ chặn nếu đã có PASS) |
| Tính năng mới vào prompt | history, workflow | Có case (D4) | Gate trên corpus đó PASS trước khi bật flag |
| Code đánh giá | `assessment-quality-gate.ts`, `assessment-release-gate-run.ts` | Unit test | Nằm trong manifest → làm **trước** freeze phase mới |

### D6. Feedback quay lại corpus (F9)

Xác nhận vòng đời `assessment.feedback`; nếu mất khi hết hạn → bản ghi tối thiểu không chứa nội dung note; báo cáo theo `promptVersion × purpose × category`; pattern lặp → case synthetic tương đương vào development; không sửa vì một case.

### D7. Chống lệch tài liệu (F8)

Sửa timeout 85s/60s, version hiện tại trong `assessment-README.md`, comment "12"→"14" trong `rubric.ts` (file trong manifest → gộp vào lần đổi v26). Thay số dễ lỗi thời bằng tham chiếu hằng số.

### D8. Review định kỳ

- [ ] `validated-configs.json` khớp config đang chạy ở mọi môi trường?
- [ ] Version nào trong fingerprint chưa có gate PASS?
- [ ] Có flag/workflow/operation/purpose/need code mới chưa có case?
- [ ] Feedback có pattern lặp chưa thành case?
- [ ] Nhà cung cấp đổi model/route/giới hạn?
- [ ] Tập validation/holdout đã dùng bao nhiêu vòng? Cần tập mới?
- [ ] Rule bảo mật, research-docs còn khớp?

### D9. Vệ sinh chỉ số gate (F18, F19)

1. Khi `remainingCaseIds` khác rỗng: gate ghi `provisional: true`, chỉ tính ca đã chạy xong (loại `errorCode` thuộc `RESUMABLE_TRANSPORT_ERROR_CODES` và `skipped`).
2. Báo `n` từng lớp cạnh macro-F1; cảnh báo khi lớp có `n < 8`.
3. Sửa `assessment-quality-gate.ts`/`assessment-release-gate-run.ts` → làm trước khi freeze phase mới.

### D10. Hai thay đổi parser đã chốt

#### D10a. F15 — chấp nhận claim là **đoạn con liên tục nguyên văn** của quote (quyết định G2)

**Phạm vi thay đổi:** chỉ điều kiện "claim khớp quote" tại `protocol.ts` L302–308 (hiện là bằng nhau sau `normalizeClaimQuote`). Đây là **nới có kiểm soát duy nhất**; mọi kiểm tra FULL khác giữ nguyên và **chạy trên chính đoạn con**: `SEMANTIC_POLARITY_MISMATCH` (L279–301), `coveragePolarityConflict`, `dropsSourceNegation`, ràng buộc coverage SUPPORTED chỉ dựa trên claim FULL `AUTHOR_REPORT` (L375–396), các guard history.

**Chuẩn hóa N(x)** — định nghĩa chính xác, áp cho cả claim và quote:
1. Unicode NFC (không dùng NFKC để tránh biến đổi ký tự tương thích — *khác `normalizeClaimQuote` hiện tại, cần quyết định thống nhất*).
2. `toLocaleLowerCase('vi')`.
3. Thống nhất nháy: `"“”` → `"`, `'‘’` → `'`.
4. Gộp mọi chuỗi khoảng trắng (`\s+`) thành một dấu cách; trim.
5. Bỏ **một** dấu câu cuối của claim thuộc `[.;,:!?]` (chỉ ở cuối claim, không bỏ trong thân).
Không bỏ dấu câu trong thân, không bỏ từ, không bỏ dấu thanh tiếng Việt.

**Điều kiện chấp nhận** (tất cả phải đúng, nếu không → giữ hành vi hiện tại `PARTIAL`):

| # | Điều kiện | Mục đích (khớp yêu cầu G2) |
|---|---|---|
| C1 | `N(claim)` xuất hiện trong `N(quote)` **đúng một lần** (nhiều lần → từ chối) | Liên tục, không mơ hồ; **không ghép đoạn rời rạc** |
| C2 | Hai đầu đoạn con nằm tại **ranh giới mệnh đề**: đầu/cuối quote, hoặc ngay sau/trước một trong `[,;:]` hoặc liên từ trong danh sách cố định (`và`, `nhưng`, `còn`, `rồi`, `and`, `but`, `while`) | Không cắt giữa mệnh đề → chống **cắt câu làm đổi nghĩa** |
| C3 | Mệnh đề bao quanh đoạn con trong quote **không chứa** phủ định/hoài nghi/điều kiện mà đoạn con không có: `hasNegation`, `hasExplicitUncertainty`, `conditionPrefix` của mệnh đề bao không được "rơi" khỏi đoạn con | Chống **bỏ từ phủ định**, **đảo trạng thái**, **thiếu ngữ cảnh điều kiện** |
| C4 | `dropsSourceNegation(source, đoạn con gốc)` = false | Không bắt đầu ngay sau từ phủ định chi phối |
| C5 | Đoạn con có tối thiểu 3 từ có nghĩa (sau khi bỏ stopword theo `words()` trong `polarity.ts`) | Chống đoạn quá ngắn không đủ ngữ cảnh ("đã chạy") |
| C6 | Mọi kiểm tra FULL hiện có pass trên đoạn con | Không nới FULL |

**Adversarial test bắt buộc** (mỗi nhóm ≥ 3 ca, tiếng Việt và tiếng Anh):

| Nhóm | Ví dụ quote → claim | Kỳ vọng |
|---|---|---|
| Bỏ từ phủ định | "Đã chạy nhưng **chưa** kiểm thử staging" → "kiểm thử staging" | Không FULL |
| Đảo trạng thái | "Đã xong phần A, **chưa** xong phần B" → "xong phần B" (là đoạn con, bắt đầu ngay sau "chưa") | Không FULL (C2, C4) |
| Cắt câu đổi nghĩa | "**Nếu** bật cờ X thì API trả 200" → "API trả 200" | Không FULL (C3 điều kiện) |
| Đoạn con thiếu ngữ cảnh | "Đã chạy kiểm thử nhưng thất bại" → "Đã chạy kiểm thử" | Không FULL (C3: mệnh đề bao chứa kết quả trái) — *cần kiểm "thất bại/failed" có trong danh sách hoài nghi/kết quả âm chưa; hiện `hasNegation` không bắt "thất bại"* |
| Ghép đoạn rời rạc | "A xong; B chưa; C xong" → "A xong C xong" | Không FULL (C1) |
| Hợp lệ (đối chứng) | "Tài khoản A đọc được, và tài khoản B nhận 403" → "tài khoản B nhận 403" | **FULL** |
| Lặp lại mơ hồ | Quote chứa đoạn con 2 lần | Không FULL |

**Kỳ vọng đã đo trước** (đếm trên 134 claim v25, chưa áp C2–C5): quy tắc C1 chuyển được **3/5** claim `AUTHOR_REPORT` không-FULL; **không** cứu được claim đầu của L1 (trích sai nguồn) → **L1 vẫn `UNDETERMINED`** sau thay đổi này. Answer usage runtime **không được kỳ vọng** tự lên 100% chỉ nhờ D10a.

**Bắt buộc trước khi merge:** replay offline 88 lượt v25 → báo cáo: số claim chuyển FULL, số coverage chuyển SUPPORTED, thay đổi adequacy runtime, và **critical errors không được tăng** (đặc biệt `falseSufficient` ở COMPLETION, nơi FULL→SUPPORTED dễ sinh ENOUGH sai).

#### D10b. F17 — `changeSummary` rỗng chỉ khi không đổi nội dung (quyết định G4)

**Áp tại** `parseAgentResult` (`work-note-agent.ts` L423–425) — dùng chung cho **rewrite (mọi workflow)** và **Assessment Editor**.

**So sánh "giống hệt"** — định nghĩa chính xác:
- Bên trái: `replacementText` **sau** `restoreText` (đã khôi phục marker).
- Bên phải: đoạn gốc tương ứng — `draft.body` (whole_note) hoặc `draft.body.slice(selection.start, selection.end)` (selection). Với Assessment Editor có author correction: so với `draft.body` gốc (không phải source đã giải mã marker).
- Chuẩn hóa M(x): chỉ (1) `\r\n` → `\n`; (2) Unicode NFC. **Không** trim, không gộp khoảng trắng, không hạ chữ hoa.
- Điều kiện: `M(left) === M(right)`.

| `changeSummary` | Nội dung | Kết quả |
|---|---|---|
| ≥ 1 mục | bất kỳ | Như hiện tại |
| `[]` | giống hệt (M) | **Chấp nhận**: `SUGGESTION_READY` không thay đổi; FE hiển thị "Không có thay đổi" thay cho danh sách rỗng |
| `[]` | khác | **Từ chối**, mã lỗi riêng `REWRITE_EMPTY_CHANGE_SUMMARY` (subcode của `INVALID_OUTPUT`); **không tự sinh summary** |
| `[]` | `operation=title` (`replacementText=null`) | **Từ chối** như hiện tại (title luôn có thay đổi) |

**Thử lại:** client hiện chỉ retry HTTP, không retry khi parser từ chối. Mặc định **trả lỗi có thể xử lý** (FE cho nút "Tạo lại"); tự động thử lại 1 lần là tùy chọn, tốn thêm call — *chưa chốt* (G-mở O4).

**Test:** unit cho 4 dòng bảng; replay offline 50 lượt Editor v25 (kỳ vọng: L7 chuyển thành chấp nhận; L6 vẫn bị từ chối vì marker); FE test hiển thị no-change.

### D11. Document/Report — đo trước, chưa có policy riêng (F7; quyết định G7)

- Giữ nguyên policy TASK_NOTE; **không** nới parser hay quy tắc bảo vệ cho Document/Report.
- **Bổ sung harness:** `run.ts`/`evaluation.ts` hiện không có trường `workflow` → thêm `workflow` vào case và vào `AgentInput` dựng trong harness (thay đổi harness, không đổi runtime).
- **Corpus `cases-rewrite-workflows-v1.json`**: PROJECT_DOCUMENT (theo `documentType`) và WORK_REPORT (body schema v2) × 8 operation, chia development/validation/holdout ngay từ đầu.
- **Chỉ số thu thập theo workflow:** false positive/false negative của clarification, lỗi polarity (mất phủ định/điều kiện), lỗi marker, F17 (changeSummary).
  **F15 không áp dụng** cho Document/Report vì hai workflow này không đi qua assessment (A1).
- Chỉ thiết kế policy riêng khi số liệu cho thấy khác biệt có hệ thống giữa workflow (so cùng chỉ số với TASK_NOTE trên cùng operation).

---

## E. Kế hoạch hành động

### Phase 0 — ✅ Đã xong

Freeze v25 (14 file), validation 20/20, holdout 40/40, baseline v25 = FAILED; blinded worksheet đã sinh.

### Phase 1 — ✅ Hoàn thành & Kiểm chứng 100%

| # | Việc | Giải | Trạng thái |
|---|---|---|---|
| 1.1 | Ghi nhận baseline v25 (14 file frozen) + báo cáo audit | F1 | ✅ Đã ghi `assessment-plan-v3-release-gate-v25-2026-11-03.json` & doc 19 |
| 1.2 | Công cụ replay offline cho release60 | nền 1.3, 1.4 | ✅ Đã tạo `scripts/work-note-agent/assessment-release-replay.ts`, replay 88 analysis + 50 editor |
| 1.3 | D10b (`changeSummary` rỗng khi không đổi) | F17 | ✅ Đã hiện thực BE (`work-note-agent.ts`) & FE (`WorkNoteProposal.tsx`) + unit tests |
| 1.4 | D10a (đoạn con câu ghép F15) + adversarial tests + replay | F15 | ✅ Đã hiện thực `polarity.ts`, `protocol.ts`, 85/85 tests passed, replay baseline an toàn |
| 1.5 | D9 vệ sinh gate: `n` per class, `provisional`, resumability | F18, F19 | ✅ Đã hiện thực `assessment-quality-gate.ts`, lưu `remainingCaseIds` & `provisional` |
| 1.6 | D1 prompt fingerprint guard (14 surfaces) | F3 | ✅ Đã tạo `prompt-fingerprints.json` & test `work-note-prompt-fingerprint.spec.ts` |
| 1.7 | D2 chế độ cảnh báo / chặn config | F4 | ✅ Đã tạo `validated-config.guard.ts` (warn trước PASS, block sau PASS) |
| 1.8 | Test nhất quán rubric & sinh rubric tự động | F6 | ✅ Đã đồng bộ `PURPOSE_RUBRIC_TABLE` với `formatAllowedBlockingNeedsLines()` |
| 1.9 | Viết 5 bộ corpus tổng hợp mới | F2, F7, F18, F20 | ✅ Đã viết `v6-release` (14 CONTRADICTORY), `dev-v26`, `history-v1`, `workflows-v1`, `editor-nochange-v1` |
| 1.10 | Harness: `workflow` (D11) & validator history | F2, F7 | ✅ Đã mở rộng harness và các bộ validator chất lượng tương ứng |
| 1.11 | Docs & manifest hygiene | F8 | ✅ Đã cập nhật đầy đủ tài liệu kỹ thuật |

### Phase 2 — v26 development còn lỗi; v27 candidate CHƯA được xác minh live

| # | Việc | Giải | Trạng thái |
|---|---|---|---|
| 2.1 | Sinh text rubric từ table (D3), `history.conflict` cho PROGRESS | F6 | ✅ Đã đồng bộ text rubric; `SELF` conflict là BLOCKING, verified live dev26-l5 |
| 2.2 | Siết điều kiện ĐỦ của QA: phải có kết quả quan sát được | F14 | ✅ Đã thêm `qaMissingObservedResult`, verified live dev26-l3 |
| 2.3 | Ví dụ few-shot `CONTRADICTORY` mới (512KB vs <=64KB) | F18 | ✅ Đã bổ sung vào `prompt.ts`, quote grounding theo đúng `sourceId`, verified live dev26-l4 |
| 2.4 | Reset purpose: dọn gap BLOCKING ngoài scope purpose mới | F16 | ✅ Đã chuẩn hóa gap trong `state.ts` khi reset hoặc `ENOUGH_FOR_PURPOSE`, verified live dev26-l2 |
| 2.5 | Comment `rubric.ts` "12"→"14"; mở rộng manifest 22 file | F5, F8 | ✅ Đã cập nhật 22 file freeze |
| 2.6 | Bump prompt versions & fingerprints; replay baseline v25 | — | ✅ Bump v26 / assessor v3 / split v3 / editor v5; fingerprints locked; replay an toàn |

### Phase 3 — Gate v26 (Đã đóng băng manifest & chạy Validation / Holdout một lượt — FAILED_AUTOMATED_GATE) & Gate v37 (`v7` corpus — AUTOMATED_GATE_PASSED 100%)

| # | Việc | Tiêu chí | Trạng thái |
|---|---|---|---|
| 3.1 | Freeze manifest v26 & v37 | Manifest ghi lại | ✅ v26 (`1ca18bec34bf...`, 22 files) giữ nguyên lịch sử; v37 (`plan-v4-release60-v37-20261105`, `--corpus=v7`, 71 files, `manifestHash = 42d0d6cb818dc3604cb5f62c45540b0f907469e355017e112c11726872e3385a`) đã đóng băng và khớp 100% với working tree |
| 3.2 | Validation Stage (20 ca) | Chạy live kiểm chứng | ❌ v26 (`v6`): `FAILED_AUTOMATED_GATE` (Question Recall 0.875, Answer Usage 0.875, Format 0.9643). ✅ **v37 (`v7`)**: **`automatedGatePassed: true`** (`criticalErrors = 0`, `Macro-F1 = 1.0000`, `Question Precision/Recall = 1.0000`, `Answer Usage = 8/8 = 1.0000`, `Format = 28/28 = 1.0000`, `Editor Acceptance = 10/10 = 1.0000`) |
| 3.3 | Holdout Stage (40 ca, một lượt) | Báo cáo kèm `n` từng lớp | ❌ v26 (`v6`): Trượt gate kỹ thuật (32/40 ca, 3 false-sufficient, Macro-F1 = 0.8002, Question Recall = 0.75, Answer Usage = 0.6667, Format = 0.9474). ✅ **v37 (`v7`, 40/40 ca, 60 lượt)**: **`automatedGatePassed: true`** (`criticalErrors = 0`, `Macro-F1 = 1.0000`, `Question Precision/Recall = 16/16 = 1.0000`, `Answer Usage = 20/20 = 1.0000`, `Format = 60/60 = 1.0000`, `Editor Acceptance = 18/18 = 1.0000`; Combined Release-60 đạt `automatedGatePassed: true`, `Macro-F1 = 1.0000`, `28/28` editor accepted) |
| 3.4 | Blinded human review & adjudication | `reviewerSemanticAssessment` | ⏳ **Chưa thực hiện (`AWAITING_BLINDED_HUMAN_REVIEW`)**: Đã sinh gói `.blinded-worksheet.json` & `.sealed-key.json` (60 transcripts) cho `v37`; giữ nguyên trung thực `NOT_ESTABLISHED` (chưa tiến hành đánh giá ngữ nghĩa thực tế) |
| 3.5 | Entry `validated-configs.json` | Cảnh báo trước PASS, chặn sau PASS | ⏳ **Chờ bước 3.4 (`DEPLOY_HUMAN_REVIEW_NOT_ESTABLISHED`)**: Giữ `entries: []` (chế độ warn-only) cho đến khi hoàn tất chấm mù thủ công (`semanticReview.status = 'PASS'`) theo đúng `assessment-deployment-gate.ts` |

### Phase 4 — Đo tính năng chưa có bằng chứng (Corpus & migration sẵn sàng, CHƯA đo đạc live)

| # | Việc | Trạng thái |
|---|---|---|
| 4.1 | Corpus history-v1 (18 ca: dev/val/holdout) | 📝 Đã soạn thảo & kiểm chứng cấu trúc bằng `validateHistoryAssessmentCorpus`; CHƯA đo đạc live chất lượng tính năng |
| 4.2 | Corpus rewrite workflows-v1 (32 ca: DOCUMENT & REPORT) | 📝 Đã soạn thảo & tích hợp đo đạc chẩn đoán theo workflow trong `evaluation.ts`; CHƯA đo đạc live chất lượng tính năng |
| 4.3 | Corpus editor nochange-v1 (12 ca) | 📝 Đã soạn thảo & kiểm chứng schema/parser D10b; CHƯA đo đạc live chất lượng tính năng |
| 4.4 | Feedback telemetry & persistence (D6) | ✅ Đã hiện thực schema MongoDB, migration script `scripts/migrations/20261103-work-note-feedback-ttl.mjs` (2/2 automated test pass, TTL 180d bảo đảm khi `autoIndex` tắt) và `feedback-report.ts` |

### Giai đoạn sau (chỉ khi có số liệu)

Gate riêng cho split; rút gọn system prompt (F13); policy theo workflow (nếu 4.2 cho thấy khác biệt); ngữ cảnh lý do cho Editor (F11); so sánh model khác.

---

## F. Những việc không nên làm

- Không chạy eval live theo cron; định kỳ chỉ dry-run, fingerprint, replay offline.
- Không dùng nội dung các ca holdout v25 (L1–L7) để viết few-shot, rule hay oracle.
- Không chạy lại "ca holdout liên quan" sau khi sửa **prompt** rồi báo như kết quả độc lập.
- Không sửa `cases-assessment-v5-release.json`.
- Không tạo phase mới hoặc nâng ceiling để lách giới hạn; phase mới phải được duyệt.
- Không tự cập nhật baseline; không sửa oracle để model qua.
- Không gộp nhiều thay đổi prompt vào một lần đo.
- Không tự sinh `changeSummary`, không tự sửa quote/claim (parser chỉ chấp nhận hoặc từ chối).
- Không nới parser/quy tắc bảo vệ cho Document/Report khi chưa có số liệu.
- Không tự fallback sang config chưa kiểm chứng; không để runtime âm thầm đổi model.
- Không đưa note thật vào corpus/report eval; không coi PASS tự động là chấp nhận ngữ nghĩa.

---

## G. Quyết định

### G-chốt (2026-11-03)

| # | Vấn đề | Quyết định | Đặc tả |
|---|---|---|---|
| 1 | Chạy nốt 4 ca holdout v25 | ✅ Xong 01:15 | A4 |
| 2 | F15 câu ghép | **Parser**: claim là đoạn con liên tục nguyên văn; không nới FULL; giữ polarity; adversarial test 5 nhóm | D10a |
| 3 | Validated config | **Cảnh báo khi chưa có PASS; chặn khi đã có PASS; không fallback sang config chưa kiểm chứng; giữ PASS gần nhất** | D2 |
| 4 | F17 `changeSummary` | **Parser D10b**: rỗng chỉ khi `replacementText` giống hệt; khác → từ chối, không tự sinh summary | D10b |
| 5 | Corpus mới | **≥ 12 `CONTRADICTORY`**, đa tình huống; giữ nguyên v5; holdout mới chạy một lượt sau freeze; chạy lại có chọn lọc | D4 |
| 6 | PROGRESS F6 | **`history.conflict` là BLOCKING** khi mâu thuẫn thật cùng target; không vì Task cha/con/khác phạm vi; rubric/server là nguồn cuối | D3 |
| 7 | Document/Report | **Đo trước**, chưa có policy riêng; không nới parser/bảo vệ | D11 |

### G-xung đột — chỗ quyết định va chạm với code hiện tại (cần biết trước khi làm)

| # | Xung đột | Bằng chứng | Đề xuất xử lý |
|---|---|---|---|
| X1 | **D10a không sửa hết L1.** Claim đầu của L1 chép từ answer lượt 2 nhưng trích quote lượt 3 → không phải đoạn con; `state.ts` cần **mọi** claim FULL | Đếm trên 134 claim v25: C1 chuyển 3/5; claim L1#1 không chuyển | Chấp nhận L1 vẫn `UNDETERMINED` (an toàn). Muốn xử lý → chọn ở O1 |
| X2 | **Corpus release cấm nguồn HISTORY**, nên các tình huống "Task cha/con" và "thông tin bị thay thế" (G5) không đưa vào v6 release được | `assessment-quality-gate.ts` L137 chỉ nhận TASK/NOTE/ANSWER | Đặt các tình huống đó vào `cases-assessment-history-v1.json` với validator riêng, hoặc nới validator release (file trong manifest → trước freeze v26) |
| X3 | **Theo hợp đồng hiện tại, Task cha/con và SUPERSEDED/OUTDATED không được cho ra `CONTRADICTORY`** (G6 cũng nói vậy), nên chúng không thể tính vào "12 `CONTRADICTORY`" | Parser cấm `CONTRADICTION` có history ref (`protocol.ts` L427–429); OUTDATED → `history.outdated` OPTIONAL | Hai tình huống này dùng làm **cặp đối chứng** (expected ≠ `CONTRADICTORY`, ví dụ `history.conflict`/`history.outdated`). 12 lượt `CONTRADICTORY` lấy từ: phủ định, đảo trạng thái, xung đột thời gian, kết quả test trái tiêu chí, hai lời khai tác giả tự mâu thuẫn |
| X4 | **"Chỉ chạy lại các ca liên quan khi sửa parser/prompt"**: với **prompt**, chạy lại ca holdout liên quan = tune trên holdout | README: "Do not tune on the holdout…" | Parser → replay offline (miễn phí, mọi ca). Prompt → chạy case **development** liên quan; holdout chỉ chạy toàn bộ một lượt sau freeze |
| X5 | **"Không nới lỏng kiểm tra FULL"** trong khi D10a vốn là nới điều kiện bằng nhau → đoạn con | `protocol.ts` L302–308 | Hiểu là: chỉ nới **duy nhất** điều kiện khớp chuỗi theo C1–C5; mọi guard FULL khác giữ nguyên, chạy trên đoạn con (D10a C6) |
| X6 | **"Giữ phiên bản PASS gần nhất"** không làm được ở runtime vì bản build chỉ chứa một phiên bản prompt | Prompt là hằng số trong code | Hiện thực ở tầng triển khai (chặn deploy) + runtime ngừng agent khi env lệch (D2) |
| X7 | **"Yêu cầu AI thử lại"** cho F17: client chỉ retry HTTP | `work-note-xkiro.client.ts` L117, L152 | Mặc định trả lỗi xử lý được; auto-retry là tùy chọn (O4) |

### G-mở — còn cần bạn chốt

| # | Câu hỏi | Lựa chọn |
|---|---|---|
| O1 | Phần L1 còn lại (claim trích sai nguồn) | (i) giữ `PARTIAL` → `UNDETERMINED` (an toàn, mặc định nếu chưa chốt); (ii) loại claim không neo được thay vì hạ adequacy (nguy cơ che lỗi model); (iii) sửa prompt/ví dụ "mỗi claim chỉ trích đúng câu chứa nó" |
| O2 | Chuẩn hóa D10a dùng NFC (đề xuất) hay giữ NFKC như `normalizeClaimQuote` hiện tại? | Thống nhất một chuẩn cho cả hai |
| O3 | Giữ ngoại lệ `history.conflict` từ PARENT/CHILD/LINKED khi `factKind = DECISION`? | Giữ (quyết định Task cha có thể ràng buộc Task con) / bỏ (đúng tinh thần "không BLOCKING vì Task cha/con") |
| O4 | F17 khác nội dung + summary rỗng: tự thử lại 1 lần? | Không (mặc định, tiết kiệm) / Có (thêm 1 call) |
| O5 | Có lối thoát khẩn khi chế độ chặn làm agent ngừng? | Chỉ redeploy bản PASS (mặc định theo G3) / thêm biến break-glass có audit |
| O6 | Corpus v6 giữ hình dạng 60 ca hiện tại hay nới validator? | Giữ (rẻ, nhanh) / nới (linh hoạt phân bố lớp) |

---

## H. Lịch sử sai sót đã sửa

### H1. Bản v1

| v1 nói | Thực tế |
|---|---|
| Cần xây golden set/metrics/registry/CI eval từ đầu | Đã có đầy đủ |
| Document/Report dùng `ASSESSMENT_EDITOR_SYSTEM_PROMPT` | Dùng `SYSTEM_PROMPT` rewrite |
| Gửi 24 ví dụ | 25 định nghĩa, gửi 4 |
| ~2.200 từ / ~4K ký tự; "~15+ spec"; "bao quát 85–90%" | ~1.910 từ / 5.683 ký tự; 27 spec; con số không có cơ sở |
| Changelog/ma trận model minh họa | Dữ liệu bịa, đã bỏ |
| CI glob; cron drift live; tự cập nhật baseline | Bỏ sót file; trái budget; che drift |

### H2. Báo cáo kết quả đo v25

| Báo cáo trước nói | Thực tế |
|---|---|
| Question recall 0.857, format 96,3% → FAIL | Do lượt 429 bị tính là lỗi; kết quả cuối 0.933 / 100% |
| "Parser quá cứng nhắc, hạ oan kết quả đúng" | Guard đúng thiết kế; model vi phạm prompt |
| L6 "biến đổi/thiếu marker" | Model giải mã marker thành `**customer_hash**` |
| L7 không rõ nguyên nhân | `changeSummary: []` bị parser từ chối |
| "Parser rule đoạn con sẽ sửa L1" (khuyến nghị G2 ban đầu) | Chỉ sửa 1/2 claim của L1; L1 vẫn `UNDETERMINED` (X1) |
| Đề xuất sửa parser ngay khi holdout còn dở | Sẽ drift manifest; đã đổi thứ tự |
  
## Review fixes — 2026-11-03

- Sửa TS2339 bằng kiểu AssessmentGap cho predicate đọc impact; chuẩn hóa formatting.
- v27 candidate: bổ sung kiểm tra rubric, số liệu/đơn vị, câu hỏi và JSON; thêm safety guard cho DECISION/COMPLETION có coverage CONTRADICTORY. Chưa có kết quả live v27, không có entry PASS mới.
- Manifest/checkpoint v26 được giữ nguyên làm bằng chứng lịch sử. Resume v26 chỉ được dùng với đúng snapshot frozen v26; KHÔNG chạy với working tree v27. Không ghi đè manifest v26 để gộp dữ liệu khác phiên bản.
- Bước tiếp theo: development v27, sau đó freeze phase mới và validation/holdout chưa thấy theo protocol; chỉ promote sau automated PASS và blinded human review. Không sử dụng lại holdout v26 làm bằng chứng độc lập.
- Migration TTL mới đã test trên MongoDB tạm; chưa áp dụng database đích. Script chỉ cho loopback, non-production; chưa có đường triển khai production được xác minh.

Validation of review fixes (2026-11-03): `npm run check` exit 0; lint 0 errors / 6 existing warnings; typecheck and build pass; unit 218 suites / 2168 tests pass (15 suites / 137 tests skipped); e2e 19 suites / 176 tests pass (2 suites / 4 tests skipped). TTL disposable-Mongo tests 2/2 pass. Replay v25: 88 analysis / 50 editor, no increase in critical errors. All 14 current prompt fingerprints match. Live v27 quality remains unverified; v26 remains FAILED. No migration applied to the target database, no commit/push/merge performed in this correction.
