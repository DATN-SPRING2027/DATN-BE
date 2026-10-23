# 07 — Performance Analysis

> [!NOTE]
> Không có Task API nào đang chạy, nên **không thể đo latency HTTP** của API đề xuất. Tài liệu này chỉ đo **chiến lược query và index ở tầng MongoDB** cho read model đề xuất, dùng dữ liệu tổng hợp. Mục tiêu là chọn thiết kế dựa trên bằng chứng **trước khi** implement. Phần đo HTTP end-to-end vẫn là việc phải làm sau khi API tồn tại (§10).

## 1. Điều kiện đo (tái lập được)

| Thuộc tính | Giá trị |
|---|---|
| Script | [`scripts/perf/workspace-query-plans.mjs`](../../scripts/perf/workspace-query-plans.mjs) |
| Lệnh | `node scripts/perf/workspace-query-plans.mjs --iterations 20` |
| An toàn | Chỉ chấp nhận `mongodb://` loopback. Mỗi lần chạy sinh tên DB duy nhất `datn_ws_perf_<pid>_<ts>_<rand>`, kiểm tra `listDatabases` đảm bảo DB chưa tồn tại trước khi chạy, và tự động `dropDatabase()` + `client.close()` trong khối `try / finally` |
| MongoDB | **8.2.3 standalone, loopback**. Production mục tiêu là MongoDB **7.0** replica set (`AGENTS.md:19`), nên số tuyệt đối có thể khác, nhưng **keysExamined/docsExamined không phụ thuộc phiên bản** |
| Node | v24.12.0 |
| Dữ liệu | 211.000 document, ~171.7 MB, seed cố định (PRNG deterministic). Gồm 3 project đích S = 1.000, M = 10.000, L = 100.000 item, cộng 40 project nhiễu × 2.500 item để kiểm tra phạm vi tenant |
| Phân phối | status `TODO` 28% / `IN_PROGRESS` 18% / `IN_REVIEW` 8% / `BLOCKED` 4% / `DONE` 37% / `CANCELLED` 5%; 85% có assignee (12 member); 65% gắn sprint (6 sprint); 70% có dueDate; ~35% là subtask (1 cấp) |
| Đo | 3 lần warm-up, sau đó 20 lần đo, lấy p50/p95/p99 thời gian round-trip client. N+1 tuần tự chỉ đo 5 lần vì quá chậm. `explain('executionStats')` cho winning plan |
| Phase | **A**: chỉ index đã approve `{projectId,_id}` · **B**: thêm 5 index với due/parent **partial** và `status` đặt trước `_id` trên index assignee/sprint · **C**: đề xuất cuối — due/parent **không partial** và `_id` đặt trước `status` (`{projectId,assigneeId,_id,status}`, `{projectId,sprintId,_id,status}`) |

## 2. Phân trang: keyset hay offset

Tier L, trang thứ 200 (vị trí 9.950):

| Chiến lược | p50 ms | p95 ms | keysExamined | docsExamined |
|---|---|---|---|---|
| offset `skip(9950).limit(50)` | 9.78 | 11.37 | **10.000** | 50 |
| keyset `_id > afterId limit 50` | 0.99 | 1.50 | **50** | 50 |

**Kết luận:**
- Chi phí offset tăng tuyến tính theo độ sâu trang, còn keyset giữ hằng số.
- Giữ **keyset** (đã approve ở D-05 DR-6). Không thêm `page/pageSize` cho Task.

## 3. Calendar: query theo khoảng ngày (35 ngày, tối đa 500 item)

| Tier | Phase | p50 ms | p95 ms | keysExamined | Plan |
|---|---|---|---|---|---|
| L | A (chỉ `project_cursor`) | 299.51 | 409.10 | 100.000 | IXSCAN(project_cursor) → FETCH → **SORT** |
| L | B (`project_due_cursor` **partial** `$type:date`) | 345.78 | 1082.17 | 100.000 | **không dùng** index partial |
| L | **C** (`project_due_cursor` không partial) | **3.54** | **4.88** | **500** | IXSCAN(project_due_cursor) → FETCH → LIMIT |
| M | A → C | 25.58 → 3.04 | 27.55 → 4.09 | 10.000 → 500 | |

**Phát hiện quan trọng:**
- Partial index với `partialFilterExpression: {dueDate: {$type: 'date'}}` **không được planner chọn** cho predicate `dueDate: {$gte, $lt}`, vì query không "ngụ ý" điều kiện `$type`. Cùng hiện tượng xảy ra với `parentId` ở §5.
- Index không partial vừa dùng được cho range query, vừa dùng được cho `dueDate: null` (drawer "unscheduled": tier L 50 keys, 1.15 ms).
- Đổi lại, index lớn hơn một chút (2.120 KB so với 1.568 KB ở 211k doc).

## 4. Filter của List, Board và Sprint Board

| Query (tier L, 100.000 task) | Phase A (`project_cursor`) keys / docs / p50 | Phase B (`status` trước `_id`) keys / docs / p50 / plan | Phase C (`_id` trước `status`) keys / docs / p50 / plan |
|---|---|---|---|
| `Q3`: `status=IN_PROGRESS` limit 50 | 262 / 262 / 1.23 ms | 50 / 50 / 0.82 ms (`IXSCAN(project_status_cursor)`) | **50 / 50 / 0.73 ms** (`IXSCAN(project_status_cursor)`) |
| `Q4`: `assigneeId=X & status∈{TODO,IN_PROGRESS,IN_REVIEW}` limit 50 | 1.226 / 1.226 / 1.88 ms | 52 / 50 / 0.67 ms (`SORT_MERGE`) | **90 / 50 / 0.66 ms** (`IXSCAN(project_assignee_cursor_status)`, lọc `status` ngay trên index key, không `FETCH` dư) |
| `Q4b`: `assigneeId=X` (không truyền `status`) limit 50 | 733 / 733 / 1.27 ms | **733 / 733 / 1.49 ms** (**bỏ qua** `project_assignee_status_cursor`, rơi về `IXSCAN(project_cursor)`) | **50 / 50 / 0.74 ms** (`IXSCAN(project_assignee_cursor_status)`) |
| `Q12`: `sprintId=S & status=IN_PROGRESS` limit 50 | 2.565 / 2.565 / 4.72 ms | 50 / 50 / 0.74 ms (`IXSCAN(project_sprint_status_cursor)`) | **265 / 50 / 0.85 ms** (`IXSCAN(project_sprint_cursor_status)`, lọc `status` trên index key, chỉ `FETCH` đúng 50 doc) |
| `Q12b`: `sprintId=S` (không truyền `status`) limit 50 | 470 / 470 / 2.21 ms | **470 / 470 / 1.20 ms** (**bỏ qua** `project_sprint_status_cursor`, rơi về `IXSCAN(project_cursor)`) | **50 / 50 / 0.87 ms** (`IXSCAN(project_sprint_cursor_status)`) |
| `Q6`: Board count theo status (`$group`) | 100.000 doc fetch / 211.8 ms | 0 doc (**covered**) / 75.4 ms | 0 doc (**covered**) / 75.4 ms (`project_status_cursor`) |

**Phát hiện quan trọng về thứ tự trường trong compound index (`_id` trước `status`):**
- Khi đặt `status` trước `_id` (`{projectId: 1, assigneeId: 1, status: 1, _id: 1}` và `{projectId: 1, sprintId: 1, status: 1, _id: 1}` ở Phase B), các truy vấn lọc đơn lẻ `assigneeId` (`Q4b`) hoặc `sprintId` (`Q12b`) **không có điều kiện `status`** nên không thể dùng thứ tự `_id: 1` của index đó. MongoDB planner buộc phải bỏ qua index và quay về quét `project_cursor` (733 và 470 doc fetch ở dữ liệu đều, hoặc tới **100.000 doc fetch** nếu sprint/assignee chỉ có ít task nằm cuối project).
- Khi đảo thành `{projectId: 1, assigneeId: 1, _id: 1, status: 1}` (`project_assignee_cursor_status`) và `{projectId: 1, sprintId: 1, _id: 1, status: 1}` (`project_sprint_cursor_status`) ở Phase C:
  - Truy vấn đơn lẻ `Q4b` và `Q12b` khớp đúng prefix `(projectId, assigneeId/sprintId, _id)` → `IXSCAN` phẳng, duyệt đúng **50 keys / 50 docs**, không sort.
  - Truy vấn kết hợp `+ status` (`Q4` và `Q12`) vẫn duyệt theo thứ tự `_id: 1` và kiểm tra `status` **ngay trong index entry** trước khi `FETCH` document (`docsExamined = 50`, không `SORT`, không `SORT_MERGE`).

## 5. Subtask: N+1 hay batched

50 parent trên một trang, tính `{total, done}`:

| Tier | Cách | Phase A p50 | Phase C p50 | keysExamined (C) |
|---|---|---|---|---|
| L | N+1 **tuần tự** (50 `countDocuments`) | **9.824,6 ms** | 47.65 ms | – |
| L | N+1 song song | 620.55 ms | 7.88 ms | – |
| L | **1 aggregation batched `$in`** | 209.81 ms | **1.41 ms** | 230 |
| M | batched | 19.14 ms | 1.79 ms | 97 |

**Kết luận:**
- Chọn **batched aggregation** + index `{projectId,parentId,_id}` không partial. Kết hợp này nhanh hơn N+1 tuần tự khoảng **6.900 lần** ở tier L.
- **Không** lưu counter denormalized. Tính lúc đọc đã đủ rẻ (≈ 1.4 ms) và không có rủi ro lệch dữ liệu.
- Index partial (phase B) cũng **không** được chọn cho `$in` (237 ms, 100.000 keys).
- Top-level timeline (`parentId: null`) dùng cùng index: 50 keys, 0.68 ms.

## 6. Overview và summary

| Tier | `$facet` 4 nhóm (p50 / p95) | 3 `$group` song song (p50 / p95) |
|---|---|---|
| S | 4.92 / 6.69 ms | 2.35 / 4.75 ms |
| M | 44.77 / 60.18 ms | **18.97 / 30.74 ms** |
| L | 596.49 / 711.91 ms | **191.99 / 234.69 ms** |

**Quyết định:** tính **on-demand** bằng các `$group` riêng chạy song song (nhanh gấp khoảng 2,4–3,1 lần `$facet`). **Không** dùng cache hay materialized view ở giai đoạn đầu.

Lý do:
1. Quy mô DATN mỗi project nhiều khả năng ≤ 10k task. Ở tier M, p95 khoảng 31 ms là đủ tốt.
2. Cache cần invalidation theo mọi create/update/transition, kèm key cách ly theo org/project. Độ phức tạp đó chưa có số đo chứng minh là cần.
3. Repo đã có mẫu cache Redis theo generation (`chat-cache.repository.ts:67-134`). Nếu sau này đo production cho thấy summary p95 > 200 ms thì có thể áp dụng: key `task-summary:{organizationId}:{projectId}:{projectTaskGeneration}`, tăng `projectTaskGeneration` trong cùng transaction với mọi write, TTL 60 s.

## 7. Tìm kiếm `q` (title chứa chuỗi)

| Tier | Từ phổ biến (`billing`) | Từ không tồn tại (worst case) |
|---|---|---|
| M | 1.84 ms (317 keys) | 27.80 ms p50 / 197.41 ms p95 (10.000 doc) |
| L | 2.15 ms (364 keys) | **339.76 ms p50 / 425.34 ms p95 (100.000 doc)** |

Regex không neo đầu chuỗi buộc phải quét toàn bộ item của project khi không có kết quả.

Quyết định cho giai đoạn đầu:
- Tìm theo **substring, escape regex**, độ dài 2–100.
- Luôn có `projectId` và `limit`.
- Đặt `maxTimeMS` (đề xuất 500 ms); khi vượt thì trả `422 TASK_SEARCH_TOO_BROAD` thay vì treo request.
- Tìm `key` chính xác ưu tiên đi qua unique index `{projectId,key}`.

Phương án mở rộng **khi đo thấy cần**:
- Thêm field `titleTokens` (mảng token đã chuẩn hóa bằng `normalizeSearchText`, `src/common/search/literal-search.ts`) với multikey index `{projectId,titleTokens}` để tìm theo prefix.
- Hoặc dùng Atlas Search như Chat (`src/common/search/indexed-search.ts`). Cách này **không áp dụng** được khi `continuum_task` bị giới hạn loopback (`AGENTS.md:7`).

## 8. Chi phí ghi, kích thước index, payload

| Chỉ số | Giá trị |
|---|---|
| Insert, chỉ `project_cursor` + `_id` | 18.91 ms / 1.000 doc |
| Insert, bộ index theo project (6 + `_id`) | 46.22 ms / 1.000 doc |
| Kích thước index (211k doc) | `_id` 2.056 KB; `project_cursor` 1.848; `project_status_cursor` 1.884; `project_assignee_cursor_status` 3.756; `project_sprint_cursor_status` 3.732; `project_due_cursor` 2.156; `project_parent_cursor` 2.284 KB |
| Payload 50 item, document đầy đủ | ~50.400 byte JSON |
| Payload 50 item, projection compact của list | ~14.800 byte (**−70,6%**) |

Chi phí ghi tăng nhưng tuyệt đối vẫn rất nhỏ (≈ 0,046 ms/doc). Workspace là tải đọc nhiều hơn ghi, nên chấp nhận được. List **bắt buộc** dùng projection compact; `description` và `steps` chỉ trả ở detail.

## 9. Bộ index đề xuất cuối cùng (gate G6 & G10, đồng bộ 100% với `04-api-inventory.yaml`)

### 9.1 Các index theo Project (7 index)

| Index | Consumer & Query Shape | Bằng chứng |
|---|---|---|
| `{projectId:1,_id:1}` (đã có `task_project_cursor`) | List mặc định, sort `_id:1`, cursor `afterId` | §2 |
| `{projectId:1,status:1,_id:1}` | Cột Board, filter `status`, count covered; sort `_id:1` | §4 (`Q3`, `Q6`) |
| `{projectId:1,assigneeId:1,_id:1,status:1}` | Lọc `assigneeId` đơn lẻ (`Q4b`, 50 keys) và kết hợp `assigneeId + status` (`Q4`, 90 keys / 50 docs, lọc `status` trên index key); sort `_id:1` | §4 (`Q4`, `Q4b`) |
| `{projectId:1,sprintId:1,_id:1,status:1}` | Lọc `sprintId` đơn lẻ (`Q12b`, 50 keys) và kết hợp `sprintId + status` (`Q12`, 265 keys / 50 docs, lọc `status` trên index key); sort `_id:1` | §4 (`Q12`, `Q12b`) |
| `{projectId:1,dueDate:1,_id:1}` **không partial** | Calendar/Timeline range (`dueFrom`/`dueTo`), sort `dueDate:1,_id:1`, token `cursor`; và `dueDate:null` | §3 |
| `{projectId:1,parentId:1,_id:1}` **không partial** | Subtask batched `$in`, list subtasks của parent, timeline top-level (`parentId:null`) | §5 |
| `{projectId:1,key:1}` unique | Tra `key` chính xác, chống trùng key khi cấp phát | thiết kế (03 §2.4) |

### 9.2 Các index toàn Organization cho màn hình Manager (6 index, Gate G10 Phương án A)

| Index | Consumer & Query Shape | Bằng chứng |
|---|---|---|
| `{organizationId:1,_id:1}` (`org_cursor`) | `GET /tasks/organization/tasks` mặc định, sort `_id:1`, `afterId` | §12 (`list`: 50 keys, 0.94 ms) |
| `{organizationId:1,status:1,_id:1}` (`org_status_cursor`) | Lọc `status` toàn org, sort `_id:1`, `afterId` | §12 (`status`: 50 keys, 0.73 ms) |
| `{organizationId:1,projectId:1,_id:1}` (`org_project_cursor`) | Lọc 1 `projectId` trong màn Manager, sort `_id:1`, `afterId` | §12 (`oneProject`: 50 keys, 0.78 ms) |
| `{organizationId:1,assigneeId:1,_id:1,status:1}` (`org_assignee_cursor_status`) | Lọc `assigneeId` đơn lẻ (`assigneeOnly`: 50 keys, 0.68 ms) và `assigneeId + status` (`assigneeStatus`: 81 keys / 50 docs, 1.24 ms), sort `_id:1`, `afterId` | §12 (`assigneeOnly`, `assigneeStatus`) |
| `{organizationId:1,dueDate:1,_id:1}` **không partial** (`org_due_cursor`) | Lọc `dueFrom`/`dueTo` toàn org, sort `dueDate:1,_id:1`, token `cursor` | §12 (`dueWindow`: 50 keys, 0.74 ms) |
| `{organizationId:1,projectId:1,status:1,dueDate:1}` (`org_project_status_due`) | Covered aggregation cho `GET /tasks/organization/task-summary` (`summary` và `overdue`) | §12 (`overdue`: 19.030 keys, 0 docs, 14.41 ms) |

**Không đề xuất:**
- index cho `priority` hoặc `type`: selectivity thấp, chỉ dùng làm filter phụ hoặc trong aggregation
- text index
- rank/LexoRank

## 10. Performance budget đề xuất và cách đo sau khi implement

| Endpoint | Budget p95 (server, ≤10k task/project) | Cách đo |
|---|---|---|
| list (mọi filter) | ≤ 50 ms | k6 hoặc autocannon qua Gateway, 20 VU, 2 phút. Log `explain` của query chậm bằng MongoDB profiler (`slowms=50`) |
| detail | ≤ 30 ms | như trên |
| create / patch / transition | ≤ 120 ms (transaction + event) | 10 VU ghi đồng thời trên cùng project; đếm `409` |
| summary | ≤ 100 ms | như trên |
| Error rate | < 0,5% (không tính 409/422 hợp lệ) | |

Các budget này là **đề xuất** dựa trên số đo tầng DB ở trên. Chúng phải được xác nhận lại bằng phép đo HTTP thật trên MongoDB 7.0 replica set khi API tồn tại. Hiện tại **chưa có** phép đo HTTP nào cho Task API.

## 11. Tài liệu tham khảo kỹ thuật

| Chủ đề | Nguồn | Ảnh hưởng tới quyết định |
|---|---|---|
| Partial index chỉ được dùng khi query ngụ ý filter expression | MongoDB Manual: *Partial Indexes → Query Coverage* | Bỏ partial index (§3, §5), đã xác nhận bằng đo |
| Quy tắc ESR (Equality, Sort, Range) cho compound index | MongoDB Manual: *The ESR (Equality, Sort, Range) Guideline* | Thứ tự `{projectId, status, _id}` và `{projectId, dueDate, _id}` |
| Covered query | MongoDB Manual: *Covered Queries* | Count Board và Org Summary không fetch doc (§4, §12) |
| `skip()` tốn chi phí tuyến tính | MongoDB Manual: *cursor.skip()* | Giữ keyset (§2) |
| `maxTimeMS` | MongoDB Manual: *cursor.maxTimeMS()* | Chặn search quá rộng (§7) |
| Hủy query cũ | TanStack Query v5: *Query Cancellation* (`signal` trong `queryFn`) | FE debounce và abort (06 §3) |
| Object-level authorization | OWASP API Security Top 10 2023: API1 BOLA | Luôn query theo `{_id, projectId}` sau khi xác thực membership |

## 12. Màn hình Manager: truy vấn task toàn Organization (gate G10)

Bổ sung ngày 2026-10-22 sau khi Thắng xác nhận mô hình vận hành (Leader vận hành từng project; Manager xem, tạo và sửa mọi project, có màn hình tổng hợp toàn org).

| Phương án | Mô tả |
|---|---|
| **A (Đã chốt)** | Thêm `organizationId` vào mỗi task (bất biến, lấy từ trusted context lúc tạo) và 6 index tiền tố `organizationId` (§9.2) |
| **B (Đối chứng)** | Không đổi schema; Gateway cung cấp danh sách `projectId` của org, Task service truy vấn `projectId: {$in: [...]}` trên các index hiện có |

**Điều kiện đo:**
- Script [`scripts/perf/workspace-org-queries.mjs`](../../scripts/perf/workspace-org-queries.mjs), bảo vệ loopback và sinh tên DB scratch duy nhất mỗi lần chạy (`datn_ws_org_perf_<pid>_<ts>_<rand>`, tự drop trong `finally`).
- 400.000 task, gồm 4 org × 40 project × 2.500 task; org đích có 100.000 task. 20 lần đo, p50/p95.
- MongoDB 8.2.3 standalone (cùng hạn chế như §1).

| Truy vấn (org 100k task, 40 project) | A (Phase 2) p50 / p95 · keys / docs · plan | B p50 / p95 · keys / docs · plan | Nhận xét |
|---|---|---|---|
| Bảng toàn org, trang đầu (`sort: {_id:1}`, `afterId`) | **0.94 / 1.53 ms** · 50 / 50 · `IXSCAN(org_cursor)` | 1.91 / 2.56 ms · 89 / 50 · `SORT_MERGE(project_cursor)` | A dùng 1 `IXSCAN` phẳng; B dùng `SORT_MERGE` trên 40 nhánh |
| Lọc `status=IN_PROGRESS` (`sort: {_id:1}`, `afterId`) | **0.73 / 1.48 ms** · 50 / 50 · `IXSCAN(org_status_cursor)` | 1.83 / 2.65 ms · 89 / 50 · `SORT_MERGE(project_status_cursor)` | A duyệt đúng 50 keys |
| Lọc `assigneeId` đơn lẻ (`assigneeOnly`, `sort: {_id:1}`) | **0.68 / 1.00 ms** · 50 / 50 · `IXSCAN(org_assignee_cursor_status)` | 1.47 / 2.24 ms · 89 / 50 · `SORT_MERGE(project_assignee_cursor_status)` | A duyệt thẳng 50 keys theo thứ tự `_id:1` |
| Lọc `assigneeId` + `status∈{TODO,IN_PROGRESS,IN_REVIEW}` (`sort: {_id:1}`) | **1.24 / 1.91 ms** · 81 / 50 · `IXSCAN(org_assignee_cursor_status)` | 1.66 / 2.51 ms · 150 / 50 · `SORT_MERGE(project_assignee_cursor_status)` | A dùng 1 `IXSCAN` phẳng và lọc `status` ngay trên index key (chỉ `FETCH` 50 doc) |
| Lọc khoảng ngày `dueFrom`/`dueTo` (`sort: {dueDate:1,_id:1}`, `cursor`) | **0.74 / 1.09 ms** · 50 / 50 · `IXSCAN(org_due_cursor)` | 1.73 / 2.53 ms · 89 / 50 · `SORT_MERGE(project_due_cursor)` | A duyệt thẳng theo thứ tự `(dueDate, _id)` |
| Lọc một project trong màn hình Manager | **0.78 / 1.01 ms** · 50 / 50 · `IXSCAN(org_project_cursor)` | 0.84 / 1.11 ms · 50 / 50 · `IXSCAN(project_cursor)` | Ngang nhau |
| Thẻ tổng hợp: đếm theo `(projectId, status)` | 75.94 / 88.81 ms · 100.000 / 0 (**covered**) | 75.57 / 106.13 ms · 100.000 / 0 (**covered**) | Ngang nhau (covered scan 100k keys) |
| Trễ hạn theo project (`overdue`) | **14.41 / 22.83 ms** · 19.030 / 0 (**covered** `org_project_status_due`) | 70.57 / 99.83 ms · 32.114 / 32.114 | A nhanh hơn ~5 lần nhờ covered index `{organizationId,projectId,status,dueDate}` |

**Quyết định đã chốt (Gate G10 = Phương án A, xác nhận ngày 2026-10-22):**
- Thắng đã xác nhận chọn **Phương án A** (lưu `organizationId` bất biến trên mỗi document `tasks` + bộ 6 index tiền tố `organizationId` ở §9.2) và xác nhận **mỗi Project gắn vĩnh viễn với `Organization` nơi nó được tạo** (không bao giờ chuyển sang Organization khác).
- Phương án A đảm bảo cách ly tenant trực tiếp ở tầng dữ liệu (mọi query đều ràng buộc `organizationId` từ trusted context), không cần truyền danh sách `projectId` qua Gateway ở mỗi request, và tránh nổ số nhánh `SORT_MERGE` khi kết hợp nhiều điều kiện lọc.
