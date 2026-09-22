# Shared file handoffs

Các packet local nằm trong `.workflow-local/`: `current-task.json`, `implementer-result.md`, `evidence.json`, `review.json` và `owner-status.md`.
Danh sách trường và cấu trúc JSON nằm tại [data model](DATA_MODEL.md); vai trò, trạng thái và quyền hạn nằm tại [V10 canonical spec](V10_CANONICAL_SPEC.md).
Trang này là danh mục file, không bổ sung quy tắc workflow.

Điểm vào là [HANDOFF](../HANDOFF.md); tiến độ ở [checklist](../docs/WORKFLOW_SIMPLIFICATION.md). Đợt này dùng `.workflow-local/workflow-simplification/` cho contract/hash, implementer-result, evidence, review và báo cáo Owner. Hồ sơ local cần chuyển riêng khi đổi máy; không đưa settings/auth vào hồ sơ.
