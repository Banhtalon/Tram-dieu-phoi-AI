# Báo cáo integration Antigravity — AG-INTEGRATE-002

Ngày thực hiện: 2026-09-19 (Asia/Ho_Chi_Minh)

## Phạm vi

- Repo: `F:\MINDX_project test\Trạm Điều Phối AI-P0-FIX`
- Mốc nền: `deb95d712df627216c25eb90a03f81ee4fec9f40`
- Worker thử nghiệm: `gemini-3.8-flash-high`
- Root trial: `F:\MINDX_project test\antigravity-integration-AG-INTEGRATE-002-20260919`
- Task directory: `TASK-AG-INTEGRATE-002`
- Dữ liệu: chỉ file giả `trial-data.txt`; không có dữ liệu dự án hoặc credential.

## Thay đổi code

- Thêm `worker.local_trial=true` với mặc định an toàn là `false` và bắt buộc `worker.model=gemini-3.8-flash-high`.
- Bridge truyền root trial, model, repository/control root và giữ ba tool `execute/continue/result`.
- Node và Python cùng kiểm tra root tuyệt đối, canonical path, symlink/junction và quan hệ `task_id -> root/task_id`; root trial phải nằm ngoài repo/control root.
- Trial truyền `--model gemini-3.8-flash-high --sandbox --mode accept-edits --output-format stream-json --print-timeout <N>s` và không chấp nhận `--dangerously-skip-permissions`.
- `accept-edits` là execution mode; `request-review` là permission mode mặc định. Permission/sandbox metadata vẫn nullable và giữ nguyên unknown; chỉ `always-proceed` hoặc `sandbox=false` là mâu thuẫn rõ ràng bị từ chối. Model/protocol/status/exit và snapshot/diff vẫn là điều kiện riêng.
- Bằng chứng init/result/tool đi qua Python → Node dưới dạng redacted và giới hạn dung lượng; lỗi gốc không bị model validator che mất khi kết quả đã là lỗi.
- `test_mode`/fake CLI vẫn là fixture riêng; bật cùng `local_trial` bị từ chối. Mặc định thật vẫn trả `WORKER_ISOLATION_UNAVAILABLE`.
- Canonical spec đã ghi local trial là thử nghiệm giám sát, không phải bằng chứng cách ly OS hay production.

## Kiểm tra code

- `python -B mcp/test_antigravity_server.py` → PASS.
- `node --test scripts/lib/implementation-worker.test.mjs` → 4/4 PASS.
- `node --test scripts/lib/harness-lifecycle.test.mjs` → 45/45 PASS.

### Cập nhật R1 — không gọi model thật

- Metadata thiếu/null/sai kiểu hoặc `sandbox=false` bị từ chối; `sandbox=null` vẫn được giữ là unknown.
- `--mode accept-edits` chỉ là tham số yêu cầu gửi cho CLI; không được dùng thay cho `permission_mode` do provider báo về.
- Test giả chứng minh worker có thể sửa file trước khi kết quả metadata bị từ chối; validation sau spawn không phải cơ chế ngăn side effect.

## Integration thật qua `AntigravityMcpWorker`

### Lượt chính

- Operation: `op-ag-integrate-002`, attempt 1.
- Timeout: `--print-timeout 60s`; MCP call timeout cùng giới hạn.
- Kết quả: `WORKER_TIMEOUT` tại cầu nối trước khi nhận result đáng tin cậy.
- Process liên quan đã được kiểm tra và đã dừng; hồ sơ lượt này không có baseline snapshot/diff đủ để kết luận trạng thái file.

### Lượt sửa lỗi duy nhất sau khi đã xác nhận process dừng

- Operation: `op-ag-integrate-002-retry`, attempt 2.
- Timeout: `--print-timeout 180s`.
- Exit code: `0`; `agent_status: SUCCESS`.
- `requested_model`: `gemini-3.8-flash-high`.
- `observed_model`: `gemini-3.8-flash-high`.
- Conversation ID: `197dbeb9-e385-49f7-8b2e-e7687e611bf8`.
- CLI báo `permission_mode: request-review`, không phải chế độ accept-edits không tương tác.
- Kết quả bị từ chối với `error_code: MCP_PROTOCOL_ERROR` và lý do: `Antigravity permission mode is not non-interactive accept-edits: request-review`.
- Sau execute, gọi `antigravity_result` trả lại đúng result lỗi của cùng operation; không có lượt chạy song song.
- argv đã kiểm tra có model, sandbox, accept-edits, stream-json và `180s`; không có `--dangerously-skip-permissions`.

## File giả và giới hạn bằng chứng

Nội dung sau integration:

```text
AG-INTEGRATE-002 synthetic fixture
status=before
```

- SHA-256 quan sát sau lượt retry: `3212D9AE07E3EE742A63D44619C103A0080F7DBAC7108E3DAE458A399E61E00E`.
- Hồ sơ cũ không có snapshot/diff trước lượt retry, nên hash này chỉ là quan sát sau lượt; không đủ để kết luận file không đổi hoặc guard đã ngăn tác động.
- Vì kiểm tra `permission_mode` diễn ra sau khi process đã spawn, mọi lượt thử sau này phải chụp snapshot/diff trước-sau, kể cả bị từ chối hoặc timeout.
- Kiểm tra cuối: không còn process `agy/python` liên quan task/root.

## Kết luận và blocker

Code và suite kiểm tra local đã đạt. Integration thật chưa đạt nghiệm thu vì provider báo `permission_mode: request-review` dù bridge truyền `--mode accept-edits`; bằng chứng hiện có chưa đủ để quy nguyên nhân cho CLI hay account. Theo policy phải dừng, không bỏ sandbox hoặc dùng `dangerously-skip-permissions`. Lượt thật cũ không có bounded event evidence qua Node để gọi lại bằng chứng đã mất; R1 chỉ bảo đảm các lượt sau giữ được bằng chứng cần thiết. Local trial chưa chứng minh cách ly cấp hệ điều hành và không được coi là production-ready.

## Cập nhật R2 — 2026-09-20 (Asia/Ho_Chi_Minh)

### Sửa bounded evidence

- Sửa nhỏ nhất trong `mcp/antigravity_server.py`: khi input có hơn `MAX_EVIDENCE_EVENTS` (64) event, `_bounded_evidence` vẫn giữ 64 event đã redacted nhưng trả `evidence_truncated=true`, kể cả phần JSON còn dưới `MAX_EVIDENCE_BYTES` (32 KiB).
- Nhánh vượt byte vẫn giữ hành vi cũ: trả một `evidence_summary` và cờ `true`.
- Regression Python kiểm tra đúng 64 event nhỏ (`false`), 65 event nhỏ (`true`) và nhánh vượt byte (`true`). Test Node worker truyền cờ qua cầu nối; test lifecycle giữ cờ trong `latest_execution`.

### Kiểm tra R2

- `python -B mcp/test_antigravity_server.py` → PASS.
- `node --test scripts/lib/implementation-worker.test.mjs` → 3/3 PASS; fixture có hơn 64 event và nhận `evidence_truncated=true`.
- `node --test scripts/lib/harness-lifecycle.test.mjs` → 45/45 PASS; cờ còn nguyên ở kết quả lifecycle.
- Không gọi model thật, không đọc credential, không thay đổi policy/guard quyền.

### Khảo sát provider contract — chỉ đọc

| Trường/lớp | Nguồn | Kết luận |
|---|---|---|
| Phiên bản executable | `C:\Users\QQ\AppData\Local\agy\bin\agy.exe --version` | `1.2.7`; SHA-256 `162607893EAACAF7B4A34BCD0BC3978342C6707B0340F96040F0139AC904DD22`. |
| CLI flags | `agy --help` | Có `--mode` với `accept-edits`, `plan`; có `--sandbox`; có `--output-format stream-json`; không có `--permission-mode`. |
| Ngữ nghĩa `--mode accept-edits` | [Execution Modes](https://antigravity.google/docs/cli/modes/) | Đây là execution mode: tự chấp nhận thao tác file. Tài liệu gọi mode mặc định là `request-review` và nói quy tắc quyền tool vẫn áp dụng riêng; không xác nhận rằng `init.permission_mode` phải đổi thành `accept-edits`. |
| Ngữ nghĩa `--sandbox` | [Terminal Sandbox](https://antigravity.google/docs/sandbox?tab=cli) | Đây là lớp sandbox cho lệnh terminal, có cờ ép bật và cấu hình riêng; tài liệu Windows nói hành vi hiện tại vẫn là nhánh Windows cũ. |
| `init.permission_mode` | [Headless / Streaming JSON](https://antigravity.google/docs/cli/headless/) | Được tài liệu hóa là “effective permission mode”; ví dụ/mặc định là `request-review`, còn `always-proceed` gắn với `--dangerously-skip-permissions`. Không có tài liệu chính thức ở đây cho giá trị `accept-edits`. |
| `init.sandbox` | [Headless / Streaming JSON](https://antigravity.google/docs/cli/headless/) | Bảng trường `init` không liệt kê trường `sandbox`; chưa có nguồn chính thức xác nhận tên, kiểu hoặc quy tắc xuất trường này. |

Kết quả thật R1 vẫn là `permission_mode=request-review` dù argv có `--mode accept-edits --sandbox`. Vì tài liệu phân biệt execution mode với permission mode và không định nghĩa `init.sandbox`, không được coi cờ CLI là metadata provider đã quan sát; `UNVERIFIED_PROVIDER_CONTRACT` vẫn mở.

Đề xuất tại R2 này đã được xử lý trong R3 bằng cách bỏ các yêu cầu schema đoán khỏi guard; xem phần R3 bên dưới.

## Cập nhật R3 — 2026-09-20 (Asia/Ho_Chi_Minh)

### Sửa contract adapter

- Python `_trial_metadata_error` và Node `trialMetadataError` vẫn bắt buộc model quan sát đúng `gemini-3.8-flash-high`.
- `--mode accept-edits` vẫn được truyền trong argv như execution mode; không dùng nó để suy ra `permission_mode`.
- `request-review` được chấp nhận là permission mode mặc định; permission metadata thiếu/null/không nhận diện và `init.sandbox` thiếu vẫn giữ nguyên là unknown.
- Chỉ từ chối mâu thuẫn rõ ràng `permission_mode=always-proceed` hoặc `sandbox=false`. Không nới `--sandbox`, không cho `--dangerously-skip-permissions`, không nới root/task guards.

### Kiểm tra R3 trước integration

- `python -B mcp/test_antigravity_server.py` → PASS.
- `node --test scripts/lib/implementation-worker.test.mjs` → 4/4 PASS.
- `node --test scripts/lib/harness-lifecycle.test.mjs` → PASS (45/45 theo suite hiện hành).
- `git diff --check` → PASS.

### Một invocation thật qua `AntigravityMcpWorker`

- Root mới: `F:\MINDX_project test\antigravity-integration-AG-INTEGRATE-002-R3`.
- Task: `TASK-AG-INTEGRATE-002-R3`; chỉ có `trial-data.txt` là dữ liệu giả.
- Đã kiểm tra root chưa tồn tại trước khi tạo; baseline có đúng 1 file, nội dung `status=before`.
- Đã chạy đúng một `AntigravityMcpWorker.execute`, operation `op-ag-integrate-002-r3`, attempt 1; không retry/continue.
- argv quan sát được (prompt đã ẩn): `agy --model gemini-3.8-flash-high --sandbox --mode accept-edits --output-format stream-json --print-timeout 180s --print <prompt>`; không có `--dangerously-skip-permissions`.
- MCP được nới thời gian chờ lên 210 giây để không race với CLI 180 giây. Executable hash SHA-256: `162607893EAACAF7B4A34BCD0BC3978342C6707B0340F96040F0139AC904DD22` (bản `agy 1.2.7` đã được ghi nhận ở R2).
- Process `agy`/MCP liên quan đã kết thúc; kiểm tra sau lượt: 0 process liên quan.

### Snapshot sau lượt và kết luận

- `trial-data.txt` sau lượt vẫn đúng 1 file, nội dung `status=before`, không có diff.
- SHA-256 baseline: `3A3BFC1F0FCAECE442E1E03CBD3F6D99699FDCE3A721446D21B6E87FA300DA34`.
- SHA-256 sau lượt: `3A3BFC1F0FCAECE442E1E03CBD3F6D99699FDCE3A721446D21B6E87FA300DA34`.
- Kết quả đã được lưu trong output tool `exec-4d891c5e-f7bd-4fa5-9a03-3e9f7185e40d` của task `01a0bab8-0b22-7b71-ac64-e2fdf0bb39ac`: `status=TIMED_OUT`, `exit_code=1`, `observed_model=gemini-3.8-flash-high`, `permission_mode=request-review`, `sandbox=null`, `conversation_id=5672d987-53af-47bf-a8a3-d44ebb1d832c`, `evidence_truncated=true`. Vì evidence đã bị giới hạn, không suy ra nội dung stream đầy đủ; không được nói là không có stream.
- Integration R3 **chưa nghiệm thu**: file không đổi nhưng kết quả runtime là timeout và evidence bị giới hạn; không suy diễn thêm về tác động ngoài file giả. Theo phiếu, dừng tại đây; không gọi trực tiếp `agy`, không retry, không gỡ quyền.

## Cập nhật R4 — 2026-09-20 (Asia/Ho_Chi_Minh)

### Sửa bounded scope guard

- `_worker_prompt` nhận workspace tuyệt đối đã được `resolve_workspace` kiểm tra và ghi rõ chỉ dùng đúng đường dẫn đó; execute và continue dùng chung prompt này. Prompt là hướng dẫn, không phải sandbox của hệ điều hành.
- Python parse toàn bộ event đã nhận trước `_bounded_evidence`. Chỉ các event có bằng chứng `view_file` và trường `AbsolutePath` được kiểm tra; đường dẫn phải tuyệt đối, không UNC/drive-relative/parent traversal, canonical bằng realpath và nằm trong workspace. Sibling-prefix, outside và path qua junction/reparse bị từ chối.
- Vi phạm sau khi worker chạy bị ghi `error_code=WORKER_SCOPE_VIOLATION`, không được nghiệm thu thành công. Đây là guard sau thực thi: không tuyên bố đã ngăn side effect hoặc giám sát mọi tool.
- Node giữ `timed_out`, `exit_code`, model, conversation và evidence; lifecycle ưu tiên `WORKER_SCOPE_VIOLATION` hơn timeout để không retry/fallback. Error code được thêm vào registry nhưng không nằm trong nhóm retryable.

### Kiểm tra R4 — không gọi model thật

- `python -B mcp/test_antigravity_server.py` → PASS; fixture kiểm tra prompt tuyệt đối, workspace/sibling-prefix/parent traversal/relative/UNC/junction và `view_file` sau event thứ 64.
- `node --test scripts/lib/implementation-worker.test.mjs` → 5/5 PASS; scope error và evidence late-event đi qua Python → Node.
- `node --test scripts/lib/harness-lifecycle.test.mjs` → 46/46 PASS; fixture timeout + scope giữ `exit_code=1`, model, conversation và evidence, không dispatch lại.
- `git diff --check` → PASS.
- Không gọi model thật, không đọc credential/transcript trực tiếp, không cài/đổi Windows/config toàn cục, không commit/merge/push.

### Giới hạn và bằng chứng file

- Review R3 ghi nhận worker đã thử đọc đường dẫn ngoài task, gồm transcript/scratch, rồi timeout; R4 chỉ ghi nhận vi phạm từ evidence `view_file`, không đọc nội dung các đường dẫn đó và không quy nguyên nhân cho tài khoản thiếu quyền.
- File giả `trial-data.txt` vẫn giữ hash baseline/sau lượt như R3. Điều đó chỉ chứng minh file giả được kiểm tra không đổi; không suy ra toàn máy không đổi.
- Hash SHA-256 các file R4 được ghi trong HANDOFF `HANDOFF.md`, mục 5; repo giữ nguyên thay đổi có sẵn và không tạo mốc commit mới.

## Bổ sung SUP1 — 2026-09-20 (Asia/Ho_Chi_Minh)

### Sửa parser false positive

- `_iter_view_file_absolute_paths` giờ chỉ đọc đúng event schema đã chứng minh: `event=step_update`, `step_update.step_type=tool`, `step_update.tool_name=view_file`, rồi lấy trực tiếp `step_update.tool_info.parameters.AbsolutePath`.
- Không còn duyệt đệ quy `output`, `result`, `text` hay nhận alias `name`/`tool`; nested output của `other_tool` vì vậy không bị coi nhầm là lệnh `view_file`.
- Actual `view_file` thiếu `AbsolutePath` hoặc có giá trị sai kiểu vẫn đi qua guard canonical hiện có và bị từ chối. Các kiểm tra root, containment/canonical, ưu tiên scope trước timeout và scan toàn bộ event trước `_bounded_evidence` được giữ nguyên.
- Fixture Python và Node worker đã được chỉnh theo schema thật; actual `view_file` ngoài root vẫn bị chặn.

### Kiểm tra SUP1 — không gọi model thật

- `python -B mcp/test_antigravity_server.py` → PASS; có regression nested `other_tool`, malformed `AbsolutePath`, actual outside-root và late event sau 64 event.
- `node --test scripts/lib/implementation-worker.test.mjs` → 5/5 PASS.
- `node --test scripts/lib/harness-lifecycle.test.mjs` → 46/46 PASS; scope vẫn thắng timeout và không dispatch lại.
- `git diff --check` → PASS.
- Không gọi model thật, không đọc credential/transcript trực tiếp, không cài/đổi Windows/config toàn cục, không commit/merge/push. Đây vẫn là kiểm tra code/fixture local, chưa phải nghiệm thu runtime thật.
