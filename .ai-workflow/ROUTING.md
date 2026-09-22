# Định tuyến hiện hành

Công việc mới theo [Direct](DIRECT_GEMINI.md): Gemini thực hiện, controller kiểm thử, Luna review, Owner nghiệm thu. Ngoại lệ ASSISTED trước dispatch xem [canonical](V10_CANONICAL_SPEC.md#current-entry-and-owner-workflow); Owner không phải chọn mã chính sách.

`workflow.mjs init` vẫn tạo task mang discriminator `CONTROLLED_DELEGATION_V1` để tương thích schema. Điều này không thay cấu hình reviewer Direct hoặc runtime tác vụ cũ.

## Hồ sơ lịch sử
`CONTROLLED_DELEGATION_V1`, `CONTROLLED_DELEGATION_V2`, `GEMINI_FIRST_V1` giữ cấu hình, phiên bản và ngân sách đã đóng băng. Binding nằm trong [canonical](V10_CANONICAL_SPEC.md#routing-and-budgets). `workflow.mjs route` dành cho legacy, không phải lựa chọn Owner cần đưa ra cho công việc mới.
