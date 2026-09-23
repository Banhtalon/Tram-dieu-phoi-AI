# Bàn giao hiện hành

Điểm bắt đầu cho AI tiếp quản. [Quy tắc v10](.ai-workflow/V10_CANONICAL_SPEC.md) là nguồn quy tắc duy nhất; [BOOTSTRAP](.ai-workflow/BOOTSTRAP.md) chỉ cách tìm packet của tác vụ đang làm.

1. Xác định tác vụ từ yêu cầu hiện tại của Owner, rồi đọc hợp đồng, checklist và bằng chứng thuộc đúng packet đó trong `.workflow-local/`. Nếu chưa có packet, tạo hồ sơ cho việc mới theo quy tắc. Không lấy review của đợt khác làm bằng chứng.
2. Kiểm tra nhánh, commit và file chưa lưu bằng `git status --short --branch` và `git rev-parse HEAD`; đối chiếu với packet. Thiếu packet của việc đang tiếp tục thì báo thiếu bằng chứng, không đoán hoặc chạy lại.
3. Với việc mới, dùng [Direct](.ai-workflow/DIRECT_GEMINI.md). Trước khi gọi AI, kiểm tra nguồn review, bộ lọc bí mật và kích thước. Nếu biết Direct không phù hợp, ghi lý do và dùng ngoại lệ ASSISTED theo quy tắc trước dispatch.

## Luồng công việc mới

Gemini 3.8 Flash High thực hiện → controller chạy kiểm tra → Luna Max review độc lập → kiểm tra sản phẩm nếu có → Owner nghiệm thu → chờ quyền gộp riêng → xác minh commit đích.

Owner chỉ cần mô tả kết quả muốn có. Lead chịu trách nhiệm lập hồ sơ, chạy công cụ, báo tình trạng bằng tiếng Việt. Reviewer không sửa mã; sau khi mã đổi phải review lại đúng commit. Tác vụ cũ tiếp tục theo phiên bản, tuyến và ngân sách đã khóa; đối soát trạng thái chưa rõ trước khi tiếp tục.

## Mẫu bàn giao

- Implementer: [mẫu giao việc](.ai-workflow/prompts/IMPLEMENTER_BOOTSTRAP.md) và [mẫu kết quả](.ai-workflow/templates/implementer-result.md).
- Reviewer: [mẫu review](.ai-workflow/prompts/REVIEWER_BOOTSTRAP.md) và [review.json](.ai-workflow/templates/review.json).

## Hồ sơ lịch sử

[Checklist tinh gọn vận hành](docs/WORKFLOW_OPERATION_SIMPLIFICATION.md) và [đợt tinh gọn trước](docs/WORKFLOW_SIMPLIFICATION.md) chỉ mở khi xử lý chính các tác vụ đó hoặc kiểm toán. Commit nguồn trước đợt vận hành: `fc5c5bc587714244ed71f1da956fb9fc8fd673f0`.
