# 01 — FE Workspace UI Inventory

| Thuộc tính | Giá trị |
|---|---|
| FE repository | `DATN-SPRING2027/DATN-FE` |
| PR | [#69](https://github.com/DATN-SPRING2027/DATN-FE/pull/69) `feat(work): refine Jira Cloud workspace layout, monochrome icons, and full-page issue view` |
| SHA đã audit | `80a324ffac9cbb1e1b45e0a34d44c9c6ef508046` (head PR #69 sau khi merge `origin/main` @ `435d3d2`) |
| Base branch | `main` |
| Stack thực tế | Next.js `^16.3.4` App Router, React `^19.2.8`, TanStack Query `^5.103.1`, next-intl, TypeScript `^5.9.3`, Vitest `^3.2.7` (theo `package.json`) |
| Ngày audit | 2026-10-22 |
| Phương pháp | Đọc source toàn bộ `src/components/work/**`, `src/components/work-notes/**`, `src/lib/queries/**`, `src/app/[locale]/(admin)/**`, BFF `src/app/api/backend/**`; theo dõi import ngoài diff PR |

> Đường dẫn bên dưới tương đối với `DATN_FE/`. Viết tắt: `WW` = `src/components/work/WorkWorkspace.tsx`, `WN` = `src/components/work-notes/WorkNotesWorkspace.tsx`, `PD` = `src/components/work/work-preview-data.ts`.

## 0. Kết luận chính

1. Khu vực Work/Workspace **chỉ gọi đúng 3 API thật**: `GET /auth/me`, `GET /iam/projects`, `GET /iam/projects/{projectId}`. Chúng chỉ dùng để nạp user, danh sách project và header project.
2. **Toàn bộ dữ liệu nghiệp vụ** (work item, subtask, comment, worklog, history, checklist, timeline, docs, forms, reports, development, work notes, weekly report, config) là **mock tĩnh** cộng với `useState`.
   - Thay đổi mất khi refresh, khi đổi project hoặc khi unmount: `WW` được render với `key={projectId}` (`src/app/[locale]/(admin)/projects/[projectId]/work/page.tsx:11`, `src/components/work/MemberWorkspace.tsx:77`).
   - Không có `localStorage`, không có delay giả, không có comment `TODO`/`FIXME`.
3. UI đã tự gắn nhãn "Preview data" (`src/components/work/WorkPageHeader.tsx:404-406`, `WW:846-848`, `WN:251-253`). Như vậy UI **không tuyên bố** dữ liệu là thật. Tuy vậy đây vẫn là màn hình chức năng chưa có backend.
4. **Không có role gating** trong `src/components/work/**`: mọi user đều thấy create/edit/delete/bulk. Work Notes có gating nhưng dựa trên **role cấp Organization**, không phải role cấp Project (`src/components/work-notes/work-notes-types.ts:14-21`).
5. API project-members đã có sẵn ở FE nhưng **không được dùng** trong Work: `src/lib/queries/projects/useProjectMembers.ts:43,90`. Mọi assignee picker đều dùng `PREVIEW_PEOPLE` (`PD:30-36`).
6. **Không có màn hình Manager tổng hợp task toàn Organization.** PR #69 chỉ có workspace theo từng project (`/workspace`, `/projects/[projectId]/work`). Yêu cầu nghiệp vụ ngày 2026-10-22 (Manager xem và sửa task mọi project, có màn hình tổng hợp) vì vậy là một màn hình FE hoàn toàn mới; xem [02 §1.6](02-fe-be-api-matrix.md).

## 1. Route map

| Route | Page file:line | Render | Loại |
|---|---|---|---|
| `/[locale]/workspace?projectId=` | `src/app/[locale]/(admin)/workspace/page.tsx:4-14` | `MemberWorkspace` → `WorkWorkspace` (`hideProjectBanner`, project switcher) | page (sidebar `src/layout/AppSidebar.tsx:31`) |
| `/[locale]/projects/[projectId]/work` | `src/app/[locale]/(admin)/projects/[projectId]/work/page.tsx:4-12` | `WorkWorkspace` | page |
| `/[locale]/projects/[projectId]/work-notes` | `.../work-notes/page.tsx:4-12` | `WorkNotesWorkspace` (standalone) | page |
| tab `work-notes` trong `WW` | `WW:897-902` | `WorkNotesWorkspace` nhúng | tab |
| Tab của `WW`: overview, list, board, calendar, timeline, development, forms, docs, reports, work-notes | `WorkPageHeader.tsx:313-327`; switch `WW:1000-1115` | `Work*View` | tab (view là local state `WW:69`, không có trên URL) |
| Work item detail | `WW:1133-1159` (`mode="modal"`) | `WorkItemDetailDialog` | modal |
| Full-page issue view | `WW:872-896` (`mode="page"`) | `WorkItemDetailDialog` | state full-page (`WW:71-72, 243-248`); **không có URL / deep link** |
| Create item | `WW:1122-1126` | `WorkItemCreateDialog` | modal |
| AI Copilot | `WW:1127-1132` | `WorkAiCopilotDialog` | modal |
| Automations / Add view | `WorkPageHeader.tsx:474-559` / `615-700` | dialog inline | modal / popover |
| Toolbar modals (chart, format rules, import CSV, feedback) | `WorkToolbar.tsx:~950-1257` | `Modal` | modal |
| Note create / report detail | `WN:409`; `WorkNotesReportPanel.tsx:165-210` | dialog | modal |
| `/projects/[projectId]`, `/overview` | `page.tsx:19-23`; `overview/page.tsx:19-24` | `ProjectDetail`, chỉ link tới `/work`, `/work-notes` (`ProjectOverview.tsx:352,372,631,675`) | page, không có work data |
| `/calendar` | `(others-pages)/calendar/page.tsx:15-21` | template Calendar với event tĩnh riêng (`components/calendar/Calendar.tsx:39-63`) | page, **không thuộc work** |
| `/dashboard` | `dashboard/page.tsx:17` | `OrganizationOverviewDashboard` (projects + org overview) | page, không có work data |

**Số view chức năng không trùng lặp:** 10 tab (Overview, List, Board, Calendar, Timeline, Development, Forms, Docs, Reports, Work Notes) cộng 1 Issue Detail (modal và full-page là cùng một component, ở hai mode). Tổng cộng **11 view chức năng**.

## 2. Inventory chức năng

Phân loại:
- `RA` = REAL_API
- `MO` = MOCK_ONLY
- `SP` = STATIC_PRESENTATION
- `LU` = LOCAL_UI_STATE
- `PI` = PARTIAL_INTEGRATION
- `BI` = BROKEN_INTEGRATION

Cột "Persist?" cho biết có cần backend persistence hay không. Pure UI state như tab, modal, column visibility không cần persistence.

### 2.1 Shell, Header, Toolbar

| Route | View/Component | User Action | Data Source | Class | Hành vi hiện tại | Persist? | Evidence |
|---|---|---|---|---|---|---|---|
| `/workspace` | MemberWorkspace | load user + project ACTIVE (page 1, size 20) | `GET /auth/me`, `GET /iam/projects` | RA | có loading/error/empty | – | `MemberWorkspace.tsx:20-69`; `src/lib/queries/projects/useProjects.ts:54-75` |
| `/workspace` | WorkPageHeader | đổi project | project đã load | RA+LU | remount `WW`, reset mọi mock edit | N | `WorkPageHeader.tsx:387-403`; `MemberWorkspace.tsx:27,71-81` |
| `/projects/:id/work` | WW | load tên/code project | `GET /iam/projects/{id}` | RA | loading/error/retry | – | `WW:65-68,804-814`; `useProjects.ts:76-89` |
| cả hai | WW | load work items | `INITIAL_PREVIEW_WORK_ITEMS` (6 item giống nhau cho mọi project) | MO | `useState([...mock])` | **Y** | `WW:82`; `PD:40-461` |
| cả hai | Header | Share space | clipboard | LU | copy URL | N | `WorkPageHeader.tsx:329-335` |
| cả hai | Header | Automations, "+ Create custom rule" | 3 rule hardcode | SP | chỉ set flag | Y nếu giữ tính năng | `WorkPageHeader.tsx:500-555` |
| cả hai | Toolbar | text search (key, title, assignee, reporter, subtask) | items in-memory | LU | filter client, chuẩn hóa NFD | Y (server search khi có dữ liệu thật) | `WW:107-178` |
| cả hai | Toolbar | filter status/priority/assignee, avatar nhanh | `PREVIEW_PEOPLE` | MO/LU | filter client | Y cho danh sách assignee | `WorkToolbar.tsx:238-265,547-560`; `WW:84-86` |
| cả hai | Toolbar | condition builder (is/is_not/contains) | in-memory | LU | filter client | N | `WW:141-165,269-287` |
| cả hai | Toolbar | group by none/status/assignee/priority | in-memory | LU | `groupWorkItems` | N | `WW:1164-1218` |
| cả hai | Toolbar | AI Search ("JQL") | parser `includes()` | MO | map từ khóa sang filter | Y nếu AI thật | `WorkToolbar.tsx:126-141` |
| cả hai | Toolbar | Refresh | `project.refetch()` | **PI** | chỉ refetch metadata project, không refetch item; ở `/workspace` query bị disable | – | `WorkToolbar.tsx:171-175`; `WW:67,937,1075` |
| cả hai | Toolbar | Export CSV, Print | `visibleItems` | LU | download Blob thật | N | `WW:738-785` |
| cả hai | Toolbar | Import CSV | chỉ tên file | **BI** | bỏ qua nội dung file, thêm 1 item giả `[IMPORTED]` | Y | `WW:787-796`; `WorkToolbar.tsx:1145-1186` |
| cả hai | Toolbar | Give feedback | – | SP | Send chỉ đóng modal | quyết định Product | `WorkToolbar.tsx:1217-1254` |
| cả hai | List bulk bar | Mark Done, Move In Progress, Delete | in-memory | MO | delete **không confirm** | Y | `WW:941-998,716-736` |

### 2.2 List

| Action | Data Source | Class | Hành vi | Persist? | Evidence |
|---|---|---|---|---|---|
| show/hide/resize/freeze column, sort cột Work, collapse group, expand subtask | `DEFAULT_WORK_LIST_COLUMNS` | LU | không lưu | N (view pref tùy chọn) | `WorkListView.tsx:142-160,279-316,521-552,653-664`; `PD:12-28` |
| inline edit status/priority/assignee | `onStatusChange`… | MO | `updateItem*` | Y | `WorkListView.tsx:712-741`; `WW:335-363` |
| row menu: Open, Add subtask, Copy link, Copy key, Flag, Log work, Delete | – | MO/BI | Log work chỉ toast; link `#KEY` không được parse; Delete không confirm | Y | `WorkListView.tsx:769-879`; `WW:289-304` |
| inline create (title, type, due, assignee) | `onInlineCreate` | MO/**BI** | bỏ due và assignee; ép assignee `PREVIEW_PEOPLE[0]` | Y | `WorkListView.tsx:156-157,318-326,1962-1969`; `WW:1066-1074` |
| subtask: toggle done, edit, assign to me, flag, log 2h, reorder, clone, convert, change parent, delete, steps | in-memory | MO | handler `WW` | Y | `WorkListView.tsx:1346-1690,1786-1798`; `WW:365-694` |
| footer "x of total" | – | LU | **không phân trang** | Y (server pagination) | `WorkListView.tsx:2035` |

### 2.3 Overview, Board, Calendar, Timeline

| View | Action | Data Source | Class | Hành vi | Persist? | Evidence |
|---|---|---|---|---|---|---|
| Overview | breakdown status/priority/type/assignee, recent, subtasks panel | tính từ `visibleItems` | MO (derived) | "last 7 days" thực ra đếm toàn bộ; "due soon" đếm mọi item có due; Highest/Lowest luôn bằng 0 | Y (aggregate) | `WorkOverviewView.tsx:39-69,78-119,159-172,301-380` |
| Board | drag-drop đổi status | `onStatusChange` | MO | HTML5 DnD, **không có thứ tự trong cột** | Y | `WorkBoardView.tsx:297-307,505-514` |
| Board | WIP limit 4 | const | SP | chỉ hiển thị, không chặn drop | Y nếu có config | `WorkBoardView.tsx:15,286-289,330-335` |
| Board | Complete sprint, Insights, "SCRUM Sprint 1" | hardcode | SP/BI | chỉ set flag | Y (entity sprint) | `WorkBoardView.tsx:60-61,100,113-116,203-277` |
| Board | quick create theo cột | `addPreviewItem` | MO | assignee `PREVIEW_PEOPLE[0]` | Y | `WorkBoardView.tsx:381-437`; `WW:1097-1106` |
| Calendar | month nav, Today, unscheduled drawer | items theo `dueDate` | MO/LU | chỉ đọc, **không có drag đổi ngày** dù copy UI nói có (`WorkPageHeader.tsx:278`) | Y (date range query) | `WorkCalendarView.tsx:30-69,109-197,356-370` |
| Timeline | epic/child, zoom, search, sort | `INITIAL_TIMELINE_EPICS` (mock riêng) | MO | vị trí bar là % giả; today marker hardcode | Y | `WorkTimelineView.tsx:34-90,225-245`; `PD:463-610` |
| Timeline | sửa start/due/color, đổi status child | local epics state | MO | **không đồng bộ** với work items | Y | `WorkTimelineView.tsx:149-223` |

### 2.4 Development, Forms, Docs, Reports, Copilot

| View | Action | Data Source | Class | Persist? | Evidence |
|---|---|---|---|---|---|
| Development | connect tool, PR sync, AI suggestion, copy CLI | `TOOL_GROUPS`, `PULL_REQUESTS`, `REPOSITORIES`, `VULNERABILITIES`, `DEPLOYMENTS` | SP/LU | Y nếu có integration thật | `WorkDevelopmentView.tsx:15-139,141-184,321-632` |
| Development | "Create fix task" | `addPreviewItem` | MO | Y | `WorkDevelopmentView.tsx:166-177` |
| Forms | template, builder, delete, share link | `INITIAL_INTAKE_FORMS` | MO | Y | `WorkFormsView.tsx:20-210`; `PD:612-643` |
| Forms | submit, tạo work item | `addPreviewItem` | MO | Y | `WorkFormsView.tsx:212-260` |
| Forms | share `?form=` | clipboard | **BI** (param không bao giờ được đọc) | Y | `WorkFormsView.tsx:196-203`; `workspace/page.tsx:9` |
| Docs | list/reader/calendar, search, filter, open linked task | `INITIAL_DOC_ARTICLES`, `DOC_CALENDAR_EVENTS` | MO | Y | `WorkDocsView.tsx:11-178,503-511` |
| Docs | edit/create doc, checklist, comment | local docs state | MO | Y | `WorkDocsView.tsx:180-305` |
| Docs | Sync SAG, request access | – | SP/BI | Y | `WorkDocsView.tsx:435,1097-1155` |
| Reports | KPI, distribution, table phân trang client (5/page) | tính từ `visibleItems` | MO (derived) | Y (aggregate + server paging) | `WorkReportsView.tsx:42,60-90,581-631` |
| Reports | burndown, velocity, cycle time | SVG/array hardcode | SP | Y | `WorkReportsView.tsx:441-466,492-536` |
| Reports | đổi report, Add widget/filter | – | LU/BI (chỉ đổi label) | Y nếu thật | `WorkReportsView.tsx:108-181,130-132` |
| Create dialog | tạo item (title*, desc, type, priority, assignee, due) | `addPreviewItem` | MO (id `preview-${Date.now()}`) | Y | `WorkItemCreateDialog.tsx:34-90,213`; `WW:306-333` |
| AI Copilot | chat | reply theo từ khóa | MO | Y (AI backend) | `WorkAiCopilotDialog.tsx:27-86` |

### 2.5 Issue Detail (modal và full-page)

| Action | Class | Hành vi | Persist? | Evidence |
|---|---|---|---|---|
| đổi status/priority/assignee, Assign to me | MO | "Assign to me" gán `PREVIEW_PEOPLE[0]` thay vì user hiện tại | Y | `WorkItemDetailDialog.tsx:3097-3218` |
| title, description, due, labels, team, reporter | SP | **chỉ đọc**; team fallback "Core Engineering" | Y | `WorkItemDetailDialog.tsx:3220-3289,1653-1658` |
| Improve with AI | MO | template string, mất khi đóng | Y nếu AI | `:386-392,1645,1751` |
| add comment | MO | author = `user.data.name`, initials = `PREVIEW_PEOPLE[0]`, createdAt "Just now" | Y | `:361-368,2950-3025`; `WW:696-714` |
| History tab | SP | 2 dòng tổng hợp giả | Y | `:3029-3040` |
| Work log tab (parent) | MO | seed `wl-1` giống nhau cho mọi item, mất khi đóng dialog | Y | `:182-193,370-384,3042-3087` |
| Watch, Create branch/commit, Run automation | SP | không làm gì | Y nếu thật | `:176-179,194,788-800,3303-3361` |
| menu "+ Add": Linked work item / Confluence page | **BI** | "Linked work item" mở form subtask; "Confluence page" ghi vào worklog note | Y | `:1661-1729` |
| subtask CRUD, steps, comment, worklog, history, bulk, reorder, prev/next | MO | handler `WW` | Y | `:113-160,232-433,600-1600,1871-1902,2197-2600` |
| open full page / back | LU | chỉ state | N (khuyến nghị deep link) | `:807-821,521-545`; `WW:243-248` |

### 2.6 Work Notes

| Action | Data Source | Class | Persist? | Evidence |
|---|---|---|---|---|
| load user/project/role | `GET /auth/me`, `GET /iam/projects/{id}`; role từ **org roles** | RA | – | `WN:61-72,130-137`; `work-notes-types.ts:14-21` |
| load notes, reports | `INITIAL_PREVIEW_NOTES` (6), `INITIAL_PREVIEW_REPORTS` (5) | MO | Y | `WN:74-75` |
| search, filter member/task/type/week, attention-only | `PREVIEW_MEMBERS`, `PREVIEW_TASKS` | MO/LU | Y cho danh sách | `WN:88-125,323-361` |
| create note | `addNote` (id `preview-…`) | MO | Y | `WorkNoteCreateDialog.tsx:89-118,183-190`; `WN:146-157` |
| Mark viewed (non-MEMBER), Save as knowledge (MEMBER) | `updateNote`, `convertToKnowledge` | MO | Y | `WorkNotesActivityPanel.tsx:90-105`; `WN:159-183` |
| submit weekly report (MEMBER) | `saveReport` (match theo **tên**) | MO | Y | `WorkNotesReportPanel.tsx:37-82`; `WN:190-217` |
| xem detail và mark reviewed (LEADER) | `markReportReviewed` | MO | Y | `WorkNotesReportPanel.tsx:85-138`; `WN:219-224` |
| Approve / Request changes knowledge (LEADER) | `updateKnowledgeStatus` | MO | Y | `WorkNotesKnowledgePanel.tsx:32-72`; `WN:185-188` |
| Config (ADMIN): template, reminder, deadline, required sections, approval | local state | MO | Y | `WorkNotesConfigPanel.tsx:18-29,95` |

## 3. Entity và field catalogue (dùng cho thiết kế contract)

Nguồn chính: `src/components/work/work-types.ts`.

| Entity | Type @ file:line | Field |
|---|---|---|
| WorkItem | `WorkItem` `work-types.ts:72-97` | `id`, `key`, `title`, `type` (TASK/BUG/STORY), `assignee`, `reporter` (WorkPerson), `priority` (LOW/MEDIUM/HIGH), `status` (TODO/IN_PROGRESS/IN_REVIEW/DONE), `resolution`, `createdAt`, `updatedAt?`, `dueDate` (string\|null), `startDate?`, `projectName`, `description?`, `parent?` {key, summary}, `labels?`, `team?`, `flagged?`, `storyPoints?`, `sprint?`, `subtasks` {completed,total}, `subtaskItems?`, `comments?` |
| Person | `WorkPerson` `:13-17` | `id`, `name`, `initials` |
| Subtask | `WorkSubtaskItem` `:40-62` | `id`, `key`, `summary`, `done`, `status`, `priority?`, `assignee?`, `reporter?`, `dueDate?`, `startDate?`, `createdAt?`, `updatedAt?`, `description?`, `estimate?` (string "2h"), `loggedTime?`, `flagged?`, `labels?`, `steps?`, `comments?`, `worklogs?`, `history?` |
| Checklist step | `WorkSubtaskStep` `:19-23` | `id`, `text`, `done` |
| Comment | `WorkCommentItem` `:64-70` | `id`, `author` (tên), `initials`, `createdAt` (free text), `text` |
| Worklog | `WorkSubtaskWorklogItem` `:25-31` | `id`, `author`, `timeSpent` (string), `note`, `createdAt` |
| History | `WorkSubtaskHistoryItem` `:33-38` | `id`, `author`, `action`, `createdAt` |
| Timeline epic | `WorkTimelineEpic` `:182-201` | `key`, `summary`, `assignee`, `status`, `progress`, `startLabel`, `endLabel`, `barColor`, `barLeft`, `barWidth`, `startDateRaw`, `dueDateRaw`, `subtasks` |
| Intake form | `WorkIntakeForm` `:205-214` | `id`, `name`, `type`, `submissions`, `status`, `createdAt`, `desc`, `fields` |
| Doc | `WorkDocArticle` `:216-244` | `id`, `category`, `title`, `excerpt`, `author`, `status` (VERIFIED/APPROVED/DRAFT), `access`, `sagChunks`, `linkedTasks`, `views`, `callout`, `bullets`, `checklist` |
| Sprint / Epic | **không có type** | chỉ có `WorkItem.sprint?` và chuỗi hardcode "SCRUM Sprint 1" |
| Work note | `WorkNote` `work-notes-types.ts:32-48` | `id`, `author` (tên), `initials`, `createdAt`, `kind` (WORK_UPDATE/WEEKLY_SUMMARY/KNOWLEDGE/DECISION), `title`, `body`, `taskKey?`, `nextStep?`, `blocker?`, `unfinished?`, `tags?`, `knowledgeStatus?`, `week` (THIS_WEEK/LAST_WEEK), `viewed` |
| Weekly report | `WeeklyReport` `work-notes-types.ts:50-61` | `id`, `member` (tên), `initials`, `status` (SUBMITTED/MISSING), `completed`, `blockers`, `nextWeek`, `updatedAt`, `reviewed`, `week` |

**Lệch contract với BE (rất quan trọng):**
- FE dùng status `IN_REVIEW`; BE Task contract dùng `BLOCKED` và `CANCELLED`.
- FE định danh người bằng **tên hiển thị**, BE dùng `ObjectId`.
- `createdAt` của FE là free text ("2 hours ago"), BE dùng ISO-8601 UTC.

Chi tiết xem [02-fe-be-api-matrix.md](02-fe-be-api-matrix.md).

## 4. API thật đang dùng trong khu vực Work

Trình duyệt gọi `/api/backend/*` → BFF → `${CONTINUUM_API_BASE_URL}/api/v1` (`src/lib/api-client.ts:6-17,106-116`). BFF là passthrough chung (`src/app/api/backend/[...path]/route.ts:15-57`).

| Endpoint | Method | Định nghĩa | Consumer |
|---|---|---|---|
| `/auth/me` | GET | `src/lib/queries/auth/useAuth.ts:59-71` | `MemberWorkspace.tsx:20`, `WW:65`, `WN:61` |
| `/iam/projects?page&pageSize&status=ACTIVE` | GET | `useProjects.ts:54-75` | `MemberWorkspace.tsx:22-26` |
| `/iam/projects/{projectId}` | GET | `useProjects.ts:76-89` | `WW:67`, `WN:63` |

Đã có ở FE nhưng **chưa dùng** trong Work:
- `/iam/projects/{id}/memberships` (`useProjectMembers.ts:43,90`)
- `/member-candidates` (`:124-125`)
- leaders (`useProjectLeaders.ts:100-210`)

## 5. Mock sources

| Source | file:line | Số record |
|---|---|---|
| `PREVIEW_PEOPLE` | `PD:30-36` | 5 |
| `DEFAULT_WORK_LIST_COLUMNS` | `PD:12-28` | 15 |
| `INITIAL_PREVIEW_WORK_ITEMS` | `PD:40-461` | 6 item, 18 subtask |
| `INITIAL_TIMELINE_EPICS` | `PD:463-610` | 4 epic, 6 child |
| `INITIAL_INTAKE_FORMS` | `PD:612-643` | 3 |
| `INITIAL_DOC_ARTICLES` | `PD:645-965` | 8 |
| parent worklog seed | `WorkItemDetailDialog.tsx:184-191` | 1 (giống nhau cho mọi item) |
| Development fixtures | `WorkDevelopmentView.tsx:15-139` | 3×8 tool / 3 PR / 3 repo / 2 vuln / 2 deploy |
| Forms fixtures | `WorkFormsView.tsx:20-112` | 7 / 6 / ~5 |
| Docs calendar | `WorkDocsView.tsx:11-110,141-152` | ~3 event, 1 comment |
| Reports fixtures | `WorkReportsView.tsx:9-40,441-536` | 6 report type, 3 sprint |
| Automation rules | `WorkPageHeader.tsx:500-513` | 3 |
| AI canned replies | `WorkAiCopilotDialog.tsx:35-61` | 3 |
| Work notes fixtures | `src/components/work-notes/work-notes-preview-data.ts:3-151` | 4 task / 5 member / 6 note / 5 report |

ID giả:
- `preview-${Date.now()}` và `PREVIEW-${n}` (`WW:309-313`)
- `${projectCode||"KNW"}-${146+n}` (`WW:561-566`)
- `comment-${Date.now()}` (`WW:702`)
- `form-${Date.now()}` (`WorkFormsView.tsx:241`)
- `String(docs.length+1)` (`WorkDocsView.tsx:234`)
- `report-${user.id}-THIS_WEEK` (`WN:204`)

## 6. Độ phủ trạng thái UI

| View | Loading | Empty | Error | Success |
|---|---|---|---|---|
| MemberWorkspace | Y | Y | Y (+retry) | Y |
| WW shell (project) | Y | – | Y (+retry) | Y |
| Work items (mọi view) | **N** (không có fetch) | Y với list/overview/board/calendar | **N** | Y |
| Timeline / Development / Reports / Docs | N | N | N | Y |
| Detail dialog | prop `isSkeletonLoading` có nhưng `WW` không truyền | "No comments yet" | N | Y |
| WN shell | Y | – | Y (+retry, "no role") | Y |
| WN panels | N | Y | N | Y |
| Permission denied | chỉ map 403 khi fetch project (`ProjectState.tsx:37-45`) | | | |

Khi tích hợp API thật, mọi view dữ liệu phải bổ sung loading, error và permission-denied.

## 7. Defect và bất nhất cần xử lý khi tích hợp

1. Mọi project dùng cùng một bộ mock; key `KNW/CSP/DAT/MOB` không khớp với code project thật (`PD:43,205,279,332,378,424`).
2. Timeline mâu thuẫn với `WorkItem.parent` (`PD:56` so với `PD:465-481`). Timeline edit không lan sang item.
3. Inline create bỏ due date và assignee (`WorkListView.tsx:318-326`; `WW:1066-1074`).
4. Nút giả hoặc chết:
   - Log work ở row (`WorkListView.tsx:854-864`)
   - Complete sprint
   - Create branch/commit, Watch, Run automation
   - Create custom rule
   - Save rules
   - Send feedback
   - Sync SAG
   - Config "Save preview"
   - Report switcher
   - "+ Add filter"
   - Import CSV
5. Menu "+ Add" nối sai handler (`WorkItemDetailDialog.tsx:1692-1715`).
6. Shortcut Shift+F và M được quảng cáo nhưng chưa có (`WorkToolbar.tsx:504-514`; `WorkItemDetailDialog.tsx:2990-2996`).
7. Link chết:
   - `#KEY` (`WorkListView.tsx:803,1432`)
   - `?form=` (`WorkFormsView.tsx:199`)
   - full-page detail không có URL
8. Metric sai nghĩa ("last 7 days", "due soon", Highest/Lowest = 0).
9. Identity:
   - "Assign to me" gán Minh Anh thay vì user hiện tại.
   - Ownership trong Work Notes so sánh theo **tên** thay vì ID (`WorkNotesActivityPanel.tsx:90-91`; `WN:126-128,192-198`).
10. Delete và bulk delete không confirm (`WorkListView.tsx:868-879`; `WW:979-986`).
11. Không có contract pagination, sort hoặc filter cho dữ liệu work (`WorkListView.tsx:2035`).
