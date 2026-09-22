# Handoff hiện hành

## Luồng mặc định

Điều phối gọi Gemini Flash 3.8 High trực tiếp bằng `scripts/direct.mjs`; Luna Max chỉ review độc lập, không làm runner hoặc worker.

1. Owner mô tả công việc.
2. Điều phối tạo task/config đã đóng băng phạm vi, rồi chạy `prepare` → `check` → `run`.
3. Worker Gemini chỉ sửa đúng file được giao. Controller tự chạy gate/test. Reviewer Luna Max kiểm tra độc lập ở chế độ chỉ đọc. Các AI có thể bàn giao kỹ thuật bằng tiếng Anh; Điều phối báo cáo Owner bằng tiếng Việt.
4. Tối đa một lượt làm đầu và một lượt sửa trong cùng tiến trình. Lỗi quota, quyền hoặc phạm vi thì dừng, không tự chạy lại.
5. Product Check bắt buộc phải đạt khi hợp đồng yêu cầu. `PRODUCT_CHECK_WAIT` chỉ cho phép chạy lại bước kiểm tra bằng `verify-product`, không gọi lại AI. `WAITING_FOR_CHECKPOINT` chờ Owner nghiệm thu; sau xác nhận, Điều phối chạy `accept` và tạo mốc khôi phục.

Hướng dẫn đầy đủ: `.ai-workflow/DIRECT_GEMINI.md`.

## Trạng thái

DIRECT-GEMINI-001 đã hoàn tất và được tích hợp ở commit `6137fa70e3bc0ed6d293d0ae5e7a988ba5fb5442`.

Hồ sơ cũ được lưu ngoài repo tại `F:\MINDX_project test\Trạm Điều Phối AI-ARCHIVE-20260922`.
