# Theo dõi đơn giản hóa workflow

Đây là kế hoạch và sổ tiến độ, không bổ sung quy tắc. Nguồn quy tắc duy nhất: [canonical spec](../.ai-workflow/V10_CANONICAL_SPEC.md).

## Mốc hiện tại
- Nhánh: `codex/workflow-simplification`.
- Commit nền: `6ed6a586cf33e86b12aa2755129669502d610835`.
- Phần đang làm: E — BLOCKED_TECHNICAL. Review cuối phát hiện lỗi báo cáo; đã hết ngân sách sửa.
- Người/AI xử lý tiếp: chờ Owner cho phép một lượt phục hồi bổ sung; sau đó Lead sửa và gửi reviewer độc lập đúng bản mới.
- Trở ngại: Direct có giới hạn 262.144 byte; riêng ngữ cảnh đã chọn tối thiểu 266.529 byte, chưa cộng bản trước/sau và prompt.
- Cách thực hiện: ASSISTED được Owner cho phép trong kế hoạch; chưa gọi Direct, không đổi giới hạn hoặc đặt lại lượt sửa.
- Rủi ro: ELEVATED vì đổi quy tắc điều phối; chỉ dữ liệu giả, không đổi tài khoản hoặc dữ liệu thật.
- Hồ sơ local: `.workflow-local/workflow-simplification/contract.json` và `contract.sha256`; thư mục này bị Git bỏ qua, cần bàn giao riêng khi đổi máy.

## Công việc trước kế hoạch này
- [x] Review luồng và xác nhận hai lỗi.
- [x] Sửa hai lỗi tại `6ed6a58`; 64/64 kiểm thử đạt; review độc lập PASS.
- [ ] Xác minh bản sửa đã được gộp vào nhánh đích. Hiện chỉ xác nhận có trên nhánh triển khai.

## Kế hoạch đơn giản hóa
- [x] A. Tạo checklist và ghi điểm khôi phục; kiểm tra ban đầu không có file thay đổi.
- [x] B. Thống nhất luồng Gemini → kiểm thử → Luna; ASSISTED trước dispatch có lý do, không lách lỗi/ngân sách.
- [x] C. Chuẩn hóa HANDOFF và mẫu bàn giao implementer/reviewer, dùng hồ sơ hiện có.
- [x] D. Báo cáo phân biệt nghiệm thu, hoàn tất trong vùng riêng và đã gộp; không áp dụng khác chưa xác minh.
- [ ] E. Chạy kiểm tra cuối và review độc lập đúng commit.
- [ ] F. Owner nghiệm thu ba ví dụ báo cáo.
- [ ] G. Gộp bản đã duyệt khi Owner cho phép; ghi commit nhánh đích.

## Trạng thái bàn giao mới nhất
- Commit mã cuối được review: `8a908a53cf7c9f6ed033c6d9e4b4b7661b990cc3`; 67/67 kiểm thử và ba ví dụ giả PASS trên commit này, nhưng review độc lập `NEEDS_FIX`, không thể nghiệm thu.
- Lỗi: file `product_check.json` có JSON hỏng vẫn làm báo cáo ghi “Không áp dụng” cho tác vụ nội bộ. Đã tái hiện bằng dữ liệu giả; báo cáo đúng phải là “Chưa xác minh”.
- Ngân sách: 2/2 lượt sửa đã dùng; 2 review có verdict NEEDS_FIX, 2 lần gọi Luna lỗi giới hạn trước verdict. Không mở lượt sửa mới hoặc đổi revision để xóa bộ đếm.
- Hồ sơ local: `.workflow-local/workflow-simplification/{state,evidence,review}.json`; phương án sửa cụ thể tại `SUPPLEMENTAL_REPAIR_PROPOSAL.md`.
- Tiếp theo: Owner cho phép ledger phục hồi riêng gồm đúng một lượt sửa và một review, hoặc giữ trạng thái bị chặn. Chưa nghiệm thu, chưa gộp.

## Bằng chứng từng phần
| Phần | Đang ở bước nào | Commit mã nguồn | Kiểm tra | Review | Việc tiếp theo |
|---|---|---|---|---|---|
| A | Đã chuẩn bị | Nền `6ed6a58` | Git sạch trước sửa | Chưa review đợt này | B–D |
| B–D | Mã đã kiểm tra, chưa đạt review | `8a908a5` | 67/67 PASS | NEEDS_FIX, lỗi hồ sơ hỏng | Chờ quyền phục hồi bổ sung |
| E–G | Bị chặn tại E | — | E có gate PASS, review NEEDS_FIX | Chưa PASS | Phục hồi có phép → F → G |

## Kiểm tra và nghiệm thu dự kiến
Chạy tại thư mục gốc dự án:

```powershell
node --test scripts/lib/direct-run.test.mjs scripts/lib/harness-lifecycle.test.mjs scripts/lib/source-allowed.test.mjs scripts/lib/report.test.mjs
git diff --check
```

Trường hợp bắt buộc: Direct giữ status và giới hạn cũ; không gọi AI từ test; hợp đồng bị đổi bị chặn; review sai phiên bản/không độc lập không báo đạt; thiếu bằng chứng không thành không áp dụng; bí mật bị che và model/usage thiếu không bị suy đoán. Review tài liệu đối chiếu trước-dispatch ASSISTED, chống chạy lại và khả năng đọc hồ sơ cũ. Owner xem ba ví dụ thực tế: chờ nghiệm thu, hoàn tất chưa gộp, bị chặn và Lead xử lý tiếp.

## Bàn giao và khôi phục
Vào từ [HANDOFF](../HANDOFF.md). Mỗi bằng chứng ghi commit mã nguồn đã kiểm tra và mã xác nhận hợp đồng; cập nhật tài liệu tiến độ sau review không được coi là review mã mới. Có sửa mã thì kiểm tra/review lại phần bị ảnh hưởng. Dùng nhánh cũ hoặc commit đảo thay đổi để khôi phục; không reset phá hủy hoặc xóa hồ sơ.

## Chưa làm trong đợt này
- [ ] Kiểm kê tác vụ cũ trước khi cân nhắc loại bỏ mã legacy; không phải điều kiện hoàn tất đợt này.
- [ ] Tự động hóa gộp; đợt này Lead chỉ gộp sau quyền rõ ràng của Owner.
- [ ] Chạy thử tài khoản Gemini/Luna thật qua Direct; kiểm thử đợt này dùng dữ liệu giả.
