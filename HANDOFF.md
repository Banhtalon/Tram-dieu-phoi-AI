# Bàn giao hiện hành

Điểm bắt đầu cho AI tiếp quản; nguồn quy tắc là [canonical spec](.ai-workflow/V10_CANONICAL_SPEC.md).

1. Đọc canonical spec, sau đó [checklist](docs/WORKFLOW_SIMPLIFICATION.md).
2. Mở `.workflow-local/workflow-simplification/contract.json` và `contract.sha256`, rồi bằng chứng và review được checklist dẫn tới. Hồ sơ local không nằm trong Git; thiếu hồ sơ thì báo thiếu bằng chứng, không suy đoán hoặc chạy lại.
3. Kiểm tra `git status --short`, `git branch --show-current`, `git rev-parse HEAD`; đối chiếu với commit nền và commit review trong checklist.
4. Tiếp tục đúng phần còn mở. Lead đối soát thao tác chưa rõ kết quả trước mọi dispatch.

## Luồng công việc mới
Gemini 3.8 Flash High thực hiện → controller kiểm thử → Luna Max review → Owner nghiệm thu → chờ gộp có phép → ghi commit đích đã xác minh.

Trước gọi AI, Lead kiểm tra nguồn review, bộ lọc và kích thước. Ngoại lệ ASSISTED và ngân sách xem [canonical](.ai-workflow/V10_CANONICAL_SPEC.md#current-entry-and-owner-workflow); lệnh xem [Direct](.ai-workflow/DIRECT_GEMINI.md). Owner không phải chọn chính sách cũ.

## Bàn giao theo vai trò
- Implementer: dùng [mẫu giao việc](.ai-workflow/prompts/IMPLEMENTER_BOOTSTRAP.md), trả [implementer-result](.ai-workflow/templates/implementer-result.md) trong packet.
- Reviewer: dùng [mẫu review](.ai-workflow/prompts/REVIEWER_BOOTSTRAP.md), trả `review.json` theo [mẫu sẵn có](.ai-workflow/templates/review.json).
- Lead: giữ một người ghi mã, cập nhật checklist và báo Owner bằng tiếng Việt; bàn giao kỹ thuật có thể dùng tiếng Anh.

## Mốc bảo toàn
Hai lỗi được sửa tại `6ed6a58`, là nền đợt này; chưa xác nhận gộp vào nhánh đích. Mốc DIRECT-GEMINI-001 lịch sử `6137fa70e3bc0ed6d293d0ae5e7a988ba5fb5442` không thay thế bằng chứng hiện tại.
