# Bàn giao hiện hành

Điểm bắt đầu cho AI tiếp quản. [Quy tắc v10](.ai-workflow/V10_CANONICAL_SPEC.md) là nguồn quy tắc duy nhất; [checklist vận hành](docs/WORKFLOW_OPERATION_SIMPLIFICATION.md) ghi tiến độ đợt đang làm.

1. Đọc quy tắc, checklist hiện tại, rồi hợp đồng và bằng chứng trong `.workflow-local/workflow-operation-simplification/` nếu đang tiếp tục đợt tinh gọn này. Với tác vụ khác, dùng packet riêng của tác vụ đó; không lấy review của đợt cũ làm bằng chứng mới.
2. Kiểm tra nhánh, commit hiện tại và file chưa lưu bằng `git status --short --branch` và `git rev-parse HEAD`; đối chiếu với packet. Thiếu packet thì báo thiếu bằng chứng, không đoán hoặc chạy lại.
3. Với việc mới, dùng [Direct](.ai-workflow/DIRECT_GEMINI.md). Trước khi gọi AI, kiểm tra nguồn review, bộ lọc bí mật và kích thước. Nếu biết Direct không phù hợp, ghi lý do và dùng ngoại lệ ASSISTED theo quy tắc trước dispatch.

## Luồng công việc mới

Gemini 3.8 Flash High thực hiện → controller chạy kiểm tra → Luna Max review độc lập → kiểm tra sản phẩm nếu có → Owner nghiệm thu → chờ quyền gộp riêng → xác minh commit đích.

Owner chỉ cần mô tả kết quả muốn có. Lead chịu trách nhiệm lập hồ sơ, chạy công cụ, báo tình trạng bằng tiếng Việt. Reviewer không sửa mã; sau khi mã đổi phải review lại đúng commit. Tác vụ cũ tiếp tục theo phiên bản, tuyến và ngân sách đã khóa; đối soát trạng thái chưa rõ trước khi tiếp tục.

## Mẫu bàn giao

- Implementer: [mẫu giao việc](.ai-workflow/prompts/IMPLEMENTER_BOOTSTRAP.md) và [mẫu kết quả](.ai-workflow/templates/implementer-result.md).
- Reviewer: [mẫu review](.ai-workflow/prompts/REVIEWER_BOOTSTRAP.md) và [review.json](.ai-workflow/templates/review.json).

Hồ sơ của [đợt tinh gọn đã gộp](docs/WORKFLOW_SIMPLIFICATION.md#đợt-tinh-gọn-kết-quả-kiểm-tra-sản-phẩm-đã-gộp) chỉ dùng để tra cứu lịch sử. Commit nguồn trước đợt vận hành này: `fc5c5bc587714244ed71f1da956fb9fc8fd673f0`.
