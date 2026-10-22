# 07 — Performance Analysis

> [!NOTE]
> Không có Task API nào đang chạy, nên **không thể đo latency HTTP** của API đề xuất. Tài liệu này chỉ đo **chiến lược query và index ở tầng MongoDB** cho read model đề xuất, dùng dữ liệu tổng hợp. Mục tiêu là chọn thiết kế dựa trên bằng chứng **trước khi** implement. Phần đo HTTP end-to-end vẫn là việc phải làm sau khi API tồn tại (§9).

## 1. Điều kiện đo (tái lập được)

| Thuộc tính | Giá trị |
|---|---|
| Script | [`scripts/perf/workspace-query-plans.mjs`](../../scripts/perf/workspace-query-plans.mjs) |
| Lệnh | `node scripts/perf/workspace-query-plans.mjs --iterations 20` |
| An toàn | Chỉ chấp nhận `mongodb://` loopback. DB cố định `datn_workspace_perf_scratch`, bị drop ở đầu và cuối lần chạy (đã kiểm tra: DB không còn sau khi chạy) |
| MongoDB | **8.2.3 standalone, loopback**. Production mục tiêu là MongoDB **7.0** replica set (`AGENTS.md:19`), nên số tuyệt đối có thể khác, nhưng **keysExamined/docsExamined không phụ thuộc phiên bản** |
| Node | v24.12.0 |
| Dữ liệu | 211.000 document, 168 MB, seed cố định (PRNG deterministic). Gồm 3 project đích S = 1.000, M = 10.000, L = 100.000 item, cộng 40 project nhiễu × 2.500 item để kiểm tra phạm vi tenant |
| Phân phối | status TODO 30% / IN_PROGRESS 20% / BLOCKED 5% / DONE 40% / CANCELLED 5%; 85% có assignee (12 member); 70% có dueDate; ~35% là subtask (1 cấp) |
| Đo | 3 lần warm-up, sau đó 20 lần đo, lấy p50/p95/p99 thời gian round-trip client. N+1 tuần tự chỉ đo 5 lần vì quá chậm. `explain('executionStats')` cho winning plan |
| Phase | **A**: chỉ index đã approve `{projectId,_id}` · **B**: thêm 4 index, trong đó due/parent là **partial** · **C**: đề xuất cuối, due/parent **không partial** |
| Raw output | `perf-run2.json` (lần chạy cuối) và `perf-run1.json` (lần đầu, xác nhận cùng xu hướng), lưu trong artifact của cuộc audit |

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
- Đổi lại, index lớn hơn một chút (2.124 KB so với 1.568 KB ở 211k doc).

## 4. Filter của List và Board

| Query (tier L) | Phase A keys / p50 | Phase C keys / p50 | Index dùng |
|---|---|---|---|
| `status=IN_PROGRESS` limit 50 | 280 / 1.19 ms | **50** / 0.86 ms | `project_status_cursor` |
| `assigneeId=X & status∈{TODO,IN_PROGRESS}` limit 50 ("My work") | 1.560 / 2.64 ms | **51** / 0.73 ms | `project_assignee_status_cursor` (SORT_MERGE, không sort trong RAM) |
| Board count theo status (`$group`) | 100.000 doc fetch / 211.8 ms | 0 doc (**covered**) / 75.4 ms | `project_status_cursor` |

Với filter selectivity cao, phase A vẫn nhanh vì `limit` dừng sớm. Lợi ích chính của index là **chặn trường hợp xấu**: filter hiếm phải quét cả project. Ví dụ ở Q4 tier L, số key phải duyệt giảm 30 lần.

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
| Insert, chỉ `project_cursor` + `_id` | 16.60 ms / 1.000 doc |
| Insert, bộ index cuối (5 + `_id`) | 33.75 ms / 1.000 doc (**+103%**) |
| Kích thước index (211k doc) | `_id` 2.056 KB; `project_cursor` 1.840; `project_status_cursor` 1.864; `project_assignee_status_cursor` 1.948; `project_due_cursor` 2.124; `project_parent_cursor` 2.272 KB |
| Payload 50 item, document đầy đủ | 49.195 byte JSON |
| Payload 50 item, projection compact của list | 13.390 byte (**−72,8%**) |

Chi phí ghi tăng gấp đôi nhưng tuyệt đối vẫn nhỏ (≈ 0,034 ms/doc). Workspace là tải đọc nhiều hơn ghi, nên chấp nhận được. List **bắt buộc** dùng projection compact; `description` chỉ trả ở detail.

## 9. Bộ index đề xuất cuối cùng (gate G6)

| Index | Consumer | Bằng chứng |
|---|---|---|
| `{projectId:1,_id:1}` (đã có `task_project_cursor`) | list mặc định, keyset | §2 |
| `{projectId:1,status:1,_id:1}` | cột Board, filter status, count covered | §4 |
| `{projectId:1,assigneeId:1,status:1,_id:1}` | "My work", filter assignee | §4 |
| `{projectId:1,dueDate:1,_id:1}` **không partial** | Calendar, unscheduled, Timeline range | §3 |
| `{projectId:1,parentId:1,_id:1}` **không partial** | subtask batched, timeline top-level | §5 |
| `{projectId:1,key:1}` unique | tra key, chống trùng key | thiết kế (03 §2.4); chưa benchmark |

**Không đề xuất:**
- index cho `priority` hoặc `type`: selectivity thấp, chỉ dùng trong aggregation
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
| Covered query | MongoDB Manual: *Covered Queries* | Count Board không fetch doc (§4) |
| `skip()` tốn chi phí tuyến tính | MongoDB Manual: *cursor.skip()* | Giữ keyset (§2) |
| `maxTimeMS` | MongoDB Manual: *cursor.maxTimeMS()* | Chặn search quá rộng (§7) |
| Hủy query cũ | TanStack Query v5: *Query Cancellation* (`signal` trong `queryFn`) | FE debounce và abort (06 §3) |
| Object-level authorization | OWASP API Security Top 10 2023: API1 BOLA | Luôn query theo `{_id, projectId}` sau khi xác thực membership |
