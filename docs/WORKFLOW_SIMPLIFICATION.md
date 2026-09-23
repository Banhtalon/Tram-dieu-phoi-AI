# Theo dõi đơn giản hóa workflow

Đây là kế hoạch và sổ tiến độ, không bổ sung quy tắc. Nguồn quy tắc duy nhất: [canonical spec](../.ai-workflow/V10_CANONICAL_SPEC.md).

## Đợt tinh gọn kết quả kiểm tra sản phẩm (đang làm)

Mốc bắt đầu: nhánh `codex/workflow-simplification`, commit `8078f362aea3322b06b681f4fec0b9d8dbcaad82`; `main` tại `b3005236636ff9f6d92f378f754e3bf5fe86e44a` là tổ tiên. Git sạch trước sửa. Đợt cũ đã được Owner nghiệm thu cách báo cáo, nhưng chưa gộp. Đợt này có phạm vi mới; bằng chứng và review đợt cũ không chứng nhận mã mới.

AI chỉ đánh dấu `[x]` sau khi xác minh, kèm commit và bằng chứng ở mục kết quả bên dưới. Nếu sửa mã sau review thì mở lại các mục kiểm tra/review bị ảnh hưởng. Mục chờ Owner và quyền gộp chỉ được đánh dấu theo lời xác nhận của Owner.

### A. Bảo toàn và khảo sát
- [x] Kiểm tra nhánh, Git sạch, mốc bắt đầu và quan hệ với `main` (lệnh Git ngày 2026-09-23).
- [x] Tạo hồ sơ yêu cầu và ngân sách riêng tại `.workflow-local/workflow-single-product/`; giữ nguyên hồ sơ đợt cũ.
- [x] Kiểm kê tất cả nơi ghi/đọc `product_check.json`, `ui_evidence.json` và `task.ui_evidence` (`controlled-bridge.mjs`, `report.mjs`).
- [x] Đối chiếu Direct với controlled, báo cáo, tiếp tục tác vụ và xác nhận hoàn tất; Direct giữ file `product-check.json` và đối chiếu checkpoint như cũ (`harness-lifecycle.mjs`).

### B. Một nguồn kết quả cho tác vụ mới
- [x] Tạo kiểm thử thất bại trước khi sửa hành vi (`product-evidence.test.mjs`, `report.test.mjs`; RED rồi GREEN).
- [x] Mẫu tác vụ mới khai báo `execution.product_evidence_storage: "single_file_v1"`; giá trị khác bị từ chối và trường này được khóa cùng yêu cầu.
- [x] Tác vụ mới qua controlled bridge chỉ ghi `product_check.json`; không ghi bản sao vào `ui_evidence.json` hoặc task. Direct giữ cách ghi riêng đã có.
- [x] Báo cáo, kiểm tra sẵn sàng, tiếp tục, xác nhận hoàn tất và xác nhận chạy thử đọc đúng nguồn chính thức (cùng hàm đọc `product-evidence.mjs`).
- [x] Thiếu/hỏng/sai task, revision, commit, hợp đồng, URL hoặc có hồ sơ phụ thì không báo đạt (kiểm thử dữ liệu giả và kiểm tra mã).
- [x] Tác vụ cũ không có dấu nhận biết tiếp tục được đọc và kiểm tra mâu thuẫn như hiện nay (kiểm thử `report.test.mjs`).
- [x] `verify-product` không gọi lại worker/reviewer hay đặt lại ngân sách (kiểm thử Direct hiện có).

### C. Hướng dẫn ngắn hơn
- [x] Quy tắc chính mô tả nguồn kết quả mới và cách đọc hồ sơ cũ.
- [x] HANDOFF, hướng dẫn Owner và tài liệu phụ dẫn về quy tắc; liên kết đã đối chiếu.
- [x] Giữ nguyên model, ngân sách, giới hạn Direct và yêu cầu bảo vệ dữ liệu (không sửa các phần đó).

### D. Kiểm tra độc lập
- [x] Kiểm thử tác vụ mới và hồ sơ cũ đạt; dùng dữ liệu giả, không gọi AI thật (98/98 tại `final-gates.log`).
- [x] Các kiểm thử review đúng commit, che bí mật và chưa gộp vẫn đạt (cùng bộ 98/98).
- [ ] Chạy bộ kiểm thử cuối đã chốt và `git diff --check`; ghi commit mã và kết quả (98/98 đạt, chờ commit và diff-check cuối).
- [ ] Reviewer độc lập PASS trên đúng commit cuối; sửa mã sau đó phải review lại.

### E. Nghiệm thu và gộp
- [x] Tạo ba ví dụ Owner từ mã mới tại `.workflow-local/workflow-single-product/OWNER_EXAMPLES.md` (dữ liệu giả).
- [x] Ghi rõ trong ba ví dụ: dữ liệu giả, không có biên nhận Gemini/Luna qua bridge, model và usage chưa xác định.
- [ ] Owner nghiệm thu đợt tinh gọn này; ghi đúng phạm vi được nghiệm thu.
- [ ] Kiểm tra lại `main`, xung đột và bản mã định gộp.
- [ ] Owner cho phép gộp riêng; sau đó gộp và ghi commit đích đã xác minh.

Khi bị chặn, giữ ô chưa tick và ghi **nguyên nhân, bằng chứng, người xử lý tiếp** tại đây. Khôi phục bằng cách đảo riêng commit đợt mới; không reset/xóa hồ sơ cũ.

### Kết quả đợt mới
- Hồ sơ đợt mới: `.workflow-local/workflow-single-product/contract.json`, SHA-256 `ca8392cff75d29dec930fb1cdbff6abebd7c288ca1d78004b9baf3c04dae0602`. Tạo trước mọi lần gọi AI; đợt này chưa gọi Direct.
- Kiểm thử RED/GREEN: thiếu module đọc kết quả và báo cáo chấp nhận hồ sơ phụ trước sửa; sau sửa 7/7 kiểm thử liên quan đạt. Bằng chứng cuối và review sẽ ghi sau commit.
- Bộ kiểm thử cuối: 98/98 PASS (`.workflow-local/workflow-single-product/final-gates.log`). Chưa chạy Gemini/Luna thật qua Direct; đây là dữ liệu giả và kiểm thử cục bộ.

## Mốc hiện tại
- Nhánh: `codex/workflow-simplification`.
- Commit nền: `6ed6a586cf33e86b12aa2755129669502d610835`.
- Phần đang làm: G — Owner đã nghiệm thu cách báo cáo qua ba ví dụ ngày 2026-09-23; chờ quyền gộp.
- Người/AI xử lý tiếp: Lead xác nhận nhánh đích không xung đột khi Owner cho phép gộp.
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
- [x] E. Chạy kiểm tra cuối và review độc lập đúng commit: 68/68 PASS; reviewer PASS trên `041c177`.
- [x] F. Owner nghiệm thu ba ví dụ báo cáo ngày 2026-09-23.
- [ ] G. Gộp bản đã duyệt khi Owner cho phép; ghi commit nhánh đích.

## Trạng thái bàn giao mới nhất
- Commit mã sửa bổ sung: `377967b01877d6fd2c7799815aaad68102e0606a`; file `product_check.json` hoặc `ui_evidence.json` hỏng giờ được báo “Chưa xác minh”. Test hồi quy tái hiện lỗi trước sửa, sau sửa đạt.
- Kiểm tra bản bàn giao `b2fe3e508b9f78e04af197bab1639137a85ade8b`: 67/67 PASS tại `final-gates-b2fe3e5.log`; `git diff --check` đạt. Ba ví dụ Owner đã tạo lại bằng dữ liệu giả trên bản này.
- Review độc lập tại `b2fe3e5`: `NEEDS_FIX`. Hai lỗi mới: review có `head` sai nhưng `candidate_head` đúng vẫn được báo đạt; chuỗi biên nhận rỗng vẫn được báo như đã có biên nhận.
- Commit mã sửa hai lỗi này: `d1b70c2236b32a70b412e3d3cb89a463dd898f8e`. Cả hai kiểm thử hồi quy đã thất bại trước sửa, đạt sau sửa; bản bàn giao `1ebabe37b633ccda15f7f3cb67cd81c9c2b6f9b1` đạt 67/67 tại `second-recovery-final-gates.log`, `git diff --check` đạt. Ba ví dụ Owner đã tạo lại trên bản này.
- Review độc lập tại `1ebabe3`: `NEEDS_FIX`. Nếu `product_check.json` PASS nhưng `ui_evidence.json` hỏng, Owner vẫn thấy “kiểm tra sản phẩm đã đạt” và bước gộp; reviewer đã tái hiện bằng dữ liệu giả. Phải xem toàn bộ hồ sơ trước khi báo đạt.
- Commit mã sửa hồ sơ hỗn hợp: `2cc19171cf4cdba4385e87e6c47547011a0c3235`. Kiểm thử hồi quy thất bại trước sửa, đạt sau sửa; 67/67 kiểm thử đạt tại `third-recovery-gates.log`.
- Bản bàn giao `8847fd34827ba0c8815e436743e97c495d231fa8` đạt 67/67 tại `third-recovery-final-gates.log`, `git diff --check` đạt; ba ví dụ Owner đã tạo lại. Review độc lập `NEEDS_FIX`: hai hồ sơ đều PASS, cùng định danh nhưng URL 3000/4000 mâu thuẫn với nhau và yêu cầu đã chốt; Owner vẫn bị báo đạt và gợi ý gộp.
- Commit sửa đối chiếu: `7277fe2870037db565a91277b23fbcfef65541ad`. Thêm kiểm thử URL sai, task bị đổi sau khóa và task thiếu.
- Bản bàn giao `041c177c0454d2b9b20826a844db08eb4398be94`: 68/68 PASS tại `fourth-recovery-final-gates.log`, `git diff --check` đạt; reviewer độc lập PASS cùng commit. Ba ví dụ Owner đã tạo lại bằng dữ liệu giả.
- Ngân sách gốc: 2/2 lượt sửa đã dùng; 2 review NEEDS_FIX, 2 lần gọi Luna lỗi giới hạn trước verdict. Ngân sách bổ sung Owner cho phép cũng đã dùng 1/1 lượt sửa và 1/1 review; ghi riêng tại `.workflow-local/workflow-simplification/supplemental-budget.json`, không đặt lại ngân sách gốc.
- Owner cho phép lượt phục hồi thứ hai đúng một sửa và một review; cả hai đã dùng 1/1, sổ riêng: `.workflow-local/workflow-simplification/second-supplemental-budget.json`.
- Owner cho phép lượt phục hồi thứ ba đúng một sửa và một review; cả hai đã dùng 1/1, verdict `NEEDS_FIX`. Sổ riêng: `.workflow-local/workflow-simplification/third-supplemental-budget.json`; không đặt lại ngân sách bằng revision/task mới.
- Owner cho phép lượt phục hồi thứ tư đúng một sửa và một review; cả hai đã dùng, review PASS, sổ riêng: `.workflow-local/workflow-simplification/fourth-supplemental-budget.json`.
- Hồ sơ local: `.workflow-local/workflow-simplification/{state,evidence,review}.json`; phạm vi lượt sửa hiện tại tại `FOURTH_RECOVERY_PROPOSAL.md`.
- Nghiệm thu Owner: “Tôi nghiệm thu cách báo cáo qua cả ba ví dụ” (2026-09-23). Đây là nghiệm thu nội dung báo cáo; chưa phải quyền gộp.
- Tiếp theo: G — chờ Owner cho phép gộp; hiện chưa gộp.

## Bằng chứng từng phần
| Phần | Đang ở bước nào | Commit mã nguồn | Kiểm tra | Review | Việc tiếp theo |
|---|---|---|---|---|---|
| A | Đã chuẩn bị | Nền `6ed6a58` | Git sạch trước sửa | Chưa review đợt này | B–D |
| B–D | Hoàn tất | `7277fe2` | 68/68 PASS | PASS trên `041c177` | E đã đạt |
| E | Hoàn tất kiểm tra/review | `7277fe2` | 68/68 PASS, diff-check sạch | PASS | F đã nghiệm thu |
| F | Owner nghiệm thu | `041c177` | Ba ví dụ giả đã tạo; Owner xác nhận đạt | Reviewer PASS | G, chờ quyền gộp |
| G | Chờ quyền gộp | `041c177` | `main` tại `b300523` là tổ tiên của nhánh này; kiểm tra lại ngay trước gộp | Reviewer PASS | Xin quyền gộp riêng |

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
