# Báo cáo probe Antigravity — AG-PROBE-001

Ngày thực hiện: 2026-09-19 (Asia/Ho_Chi_Minh)

## Phạm vi và đường dẫn

- Repo được kiểm tra: `F:\MINDX_project test\Trạm Điều Phối AI-P0-FIX`
- Mốc nền: `deb95d712df627216c25eb90a03f81ee4fec9f40`
- Executable: `C:\Users\QQ\AppData\Local\agy\bin\agy.exe`
- Thư mục thử nghiệm sạch, ngoài repo: `F:\MINDX_project test\antigravity-probe-AG-PROBE-001-20260919`
- Sau lượt gọi, thư mục probe vẫn rỗng. Không sao chép dữ liệu dự án hoặc credential vào đó.

## Kiểm tra khả năng CLI

- `agy.exe --help` → exit `0`.
- `agy.exe models` → exit `0`; danh sách có `gemini-3.8-flash-high`.
- Danh sách model chỉ chứng minh model có thể được chọn, không phải bằng chứng model đã chạy.

## Lượt chuẩn bị bị từ chối bởi tham số

Lệnh đã thử với cùng prompt nhưng `--print-timeout 60`:

```text
C:\Users\QQ\AppData\Local\agy\bin\agy.exe --sandbox --mode plan --model gemini-3.8-flash-high --output-format stream-json --print-timeout 60 --print "<prompt>"
```

- Thời gian UTC: `2026-09-19T15:49:01.3816809Z`–`2026-09-19T15:49:01.4662748Z` (0,085 giây).
- Exit code: `2`.
- Trạng thái: chưa gọi model; CLI báo `invalid value "60" for flag -print-timeout: time: missing unit in duration "60"`.
- Đã chờ process kết thúc trước khi thử lại. Sửa tối thiểu theo thông báo trợ giúp thành `60s`.

## Lượt probe thật

ARGV thực tế, đã ẩn nội dung prompt trong phần ghi lệnh:

```text
C:\Users\QQ\AppData\Local\agy\bin\agy.exe --sandbox --mode plan --model gemini-3.8-flash-high --output-format stream-json --print-timeout 60s --print "<prompt>"
```

Prompt vô hại:

```text
Reply with exactly: AG-PROBE-001-OK. Do not use tools. Do not read or modify files. Do not access the network. Do not include any other text.
```

- Working directory: `F:\MINDX_project test\antigravity-probe-AG-PROBE-001-20260919`.
- Thời gian UTC: `2026-09-19T15:49:17.5830034Z`–`2026-09-19T15:49:29.0961324Z`; thời gian thực tế `11,513` giây, dưới giới hạn 60 giây.
- Exit code: `0`; timeout: không; output limit: không; stderr: rỗng.
- Stream `init` báo `model: gemini-3.8-flash-high` và `cwd` đúng thư mục probe.
- Stream `init` báo `permission_mode: request-review`; lệnh không có `--dangerously-skip-permissions`.
- Stream `init` có `expanded_commands` với mục `plan`, phù hợp `--mode plan`.
- Conversation ID: `00c83fab-4f5f-48eb-87af-7353bd4e59fb`.
- Stream `result` báo `status: SUCCESS`, `num_turns: 1`.
- Câu trả lời chính xác: `AG-PROBE-001-OK`.
- `observed_agent`: không được CLI báo; không suy đoán từ cấu hình.
- CLI liệt kê các tool khả dụng trong metadata nhưng không có event gọi tool nào; prompt không yêu cầu tool, đọc file, sửa file hoặc mạng. Đây không phải bằng chứng sandbox bảo vệ toàn máy.
- Metadata usage provider báo `total_tokens: 13704`; không dùng số này để suy quota.

## Phạm vi thay đổi và kết luận

- Thay đổi của lượt này trong repo: thêm file báo cáo này và cập nhật `F:\MINDX_project test\Trạm Điều Phối AI\HANDOFF.md`.
- Không sửa source, guard, config, policy; không cài SDK/công cụ; không đổi Windows, tài khoản hoặc quyền; không commit/merge/push.
- Các thay đổi có sẵn `docs/WORKER_ISOLATION_DESIGN.md`, `docs/superpowers/` và `mcp/__pycache__/` được giữ nguyên.
- Kết luận: AG-PROBE-001 bước 1 có bằng chứng gọi thật thành công đúng model quan sát được, sandbox và plan mode được truyền/quan sát, phản hồi hợp lệ. Chưa chứng minh worker sản phẩm hoặc isolation cấp hệ điều hành; chưa thực hiện bước 2.
