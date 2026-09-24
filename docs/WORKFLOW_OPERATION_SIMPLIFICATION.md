# Checklist tinh gọn vận hành

Nguồn quy tắc: [V10 canonical](../.ai-workflow/V10_CANONICAL_SPEC.md). Đây là sổ tiến độ của đợt mới, không bổ sung quy tắc. Hồ sơ cục bộ: `.workflow-local/workflow-operation-simplification/`; SHA-256 hợp đồng phiên bản 3: `4e62724f7d7c3f3f62552f875b124eae8e5f600a577815e064001da4d3ae6e97`.

**Cách đánh dấu:** Chỉ đổi `[ ]` thành `[x]` sau khi đã làm và ghi bằng chứng thật ở phần kết quả. Nếu thất bại hoặc chưa rõ, để nguyên `[ ]`, ghi nguyên nhân và người xử lý tiếp. Sửa mã sau review thì mở lại mục kiểm tra/review bị ảnh hưởng. Nghiệm thu và quyền gộp chỉ đánh dấu theo lời xác nhận của Owner.

## A. Bảo toàn và kiểm kê

- [x] A1. Kiểm tra Git sạch, nhánh và commit nền trước sửa; tạo worktree riêng và nhánh `codex/operation-simplification`.
- [x] A2. Tạo hợp đồng đợt mới với phạm vi, rủi ro ELEVATED, giới hạn sửa/review và bốn phép kiểm tra cuối; khóa bằng SHA-256 trước sửa mã.
- [x] A3. Kiểm kê mọi hồ sơ liên quan tới kho này theo đường chạy, trạng thái, commit mã; hồ sơ không đọc được tính là chưa hoàn tất.
- [x] A4. Ghi riêng các tác vụ Direct đang dở và xác nhận không thay đổi hồ sơ của chúng.
- [x] A5. Chạy bộ kiểm tra nền trên worktree mới trước sửa.

## B. Một đường cho việc mới

- [x] B1. HANDOFF và BOOTSTRAP dẫn tới quy trình hiện tại; checklist/hợp đồng đợt đã gộp chỉ còn liên kết lịch sử.
- [x] B2. Hướng dẫn thông thường dùng `prepare → run`; `check/status` là lệnh kiểm tra khi cần, không bắt buộc chạy lặp.
- [x] B3. Nêu rõ `verify-product`, Owner nghiệm thu, quyền gộp riêng và điều kiện ASSISTED trước dispatch.
- [x] B4. Tạo một mẫu cấu hình Direct: Gemini 3.8 Flash High làm, Luna Max review, không reviewer dự phòng; chỉ rõ giá trị cần thay cho từng tác vụ.
- [x] B5. Kiểm thử mẫu bằng dữ liệu giả; cấu hình sai bị từ chối trước khi gọi AI.

## C. Giữ khả năng phục hồi của hồ sơ đã khóa

- [x] C1. Đối chiếu các nơi Direct dùng mã hợp đồng, lọc bí mật và khóa người ghi với dấu xác nhận nguồn của hồ sơ cũ.
- [x] C2. Quyết định giữ nguyên lõi `controlled-bridge`, `execution-policy` và `bridge` cho tác vụ đã khóa: tách mã sẽ đổi dấu nguồn mà không giảm tổng mã đáng kể.
- [x] C3. Kiểm thử khóa hợp đồng và cấu hình bị sửa bằng bộ kiểm tra hiện có; không đổi schema hoặc mã xác nhận.
- [x] C4. Đọc trạng thái thật của hai hồ sơ Direct bằng lệnh chỉ đọc; không gọi AI, không sửa trạng thái hoặc ngân sách.
- [x] C5. Ghi rõ đường phục hồi bằng commit trước thay đổi và bản sao packet nếu runtime hiện hành không đọc được hồ sơ cũ.

## D. Cho nghỉ đường không còn dùng

- [x] D1. Đối chiếu từng đường cũ với kiểm kê; đường còn tác vụ chưa xong được giữ ở chế độ chỉ tiếp tục và ghi rõ hồ sơ.
- [x] D2. Xử lý Fast Lane: bỏ khi không có hồ sơ cần tiếp tục, hoặc ghi lý do giữ phần cần thiết.
- [x] D3. Xử lý `pilot/run/resume/quota-drill/activate` cũ theo cùng quy tắc; giữ `report/recover/reconcile` Direct còn cần.
- [x] D4. Việc mới không còn chọn V2, GEMINI_FIRST hay FAST; tác vụ cũ không bị chuyển tuyến hoặc đặt lại ngân sách.
- [x] D5. Cập nhật canonical trong phiên bản mới và ghi commit mã trước đợt này để khôi phục đường lịch sử.
- [x] D6. Xác nhận không xóa/ghi đè hồ sơ tác vụ, bản lưu và thư mục làm việc.

## E. Kiểm tra, review và nghiệm thu

- [x] E1. `node --test scripts/lib/*.test.mjs` đạt, không còn kiểm thử thất bại.
- [x] E2. `pwsh -NoLogo -NoProfile -File scripts/provisioning-safety.test.ps1` đạt.
- [x] E3. `python mcp/test_antigravity_server.py` đạt.
- [x] E4. `git diff --check` đạt; liên kết tài liệu và lệnh mẫu đúng.
- [x] E5. Direct giữ giới hạn 256 KiB, bảo vệ bí mật, ngân sách, review độc lập và bước nghiệm thu.
- [x] E6. Reviewer độc lập PASS trên đúng commit mã cuối; nếu sửa mã sau đó, kiểm tra và review lại.
- [x] E7. Lead báo Owner phần bỏ, phần phải giữ, kết quả và phần chưa chạy tài khoản thật.
- [ ] E8. Owner nghiệm thu theo lời xác nhận rõ ràng.
- [x] E9. Owner cho phép gộp riêng; sau khi gộp, xác minh commit đích và Git sạch.

## Bằng chứng và quyết định

- Nền: `fc5c5bc587714244ed71f1da956fb9fc8fd673f0`; worktree riêng từ `main`, nhánh `codex/operation-simplification`.
- A1: `git status --short --branch` sạch trước sửa; worktree được tạo riêng.
- A2: `.workflow-local/workflow-operation-simplification/contract.json`, revision 2 và hash ở đầu trang. Phạm vi thêm `HANDOFF_FILES.md` cùng allowlist Fast Lane; bằng chứng revision 1 bị thay thế.
- A5: `node --test scripts/lib/*.test.mjs` 99/99; PowerShell 57/57; Python smoke exit 0.
- A3/A4: kho chính có hai Direct packet đang dở: `TASK-REVIEWER-LUNA-001` ở `RECOVERY_REQUIRED` (lỗi `WORKER_TIMEOUT`, 0 attempt/repair), `TASK-SOURCE-FILTER-001` ở `BLOCKED` (lỗi `RECOVERY_REQUIRED`, 0 attempt/repair). Hồ sơ cũ của đợt tinh gọn và ví dụ giả đã đóng; không thấy packet Fast Lane cần tiếp tục. Chỉ đọc hai packet bên ngoài repo, không sửa.
- B: HANDOFF/BOOTSTRAP dẫn tới packet của đúng task (không ghim checklist đợt này); Direct/ROUTING dẫn tới đường hiện tại; mẫu Direct được dùng trong kiểm thử `prepareDirect`, reviewer Luna Max, không fallback; `run` tự preflight.
- C: Direct phụ thuộc `controlled-bridge`, `execution-policy`, `bridge`; các file này nằm trong dấu nguồn legacy. Tách ra sẽ tăng mã trùng hoặc đổi dấu nguồn của packet đã khóa. Giữ nguyên để phục hồi; kiểm thử hiện có chặn task/config bị sửa (`harness-lifecycle.test.mjs`, checkpoint/accept). Lệnh `direct status` đọc đúng hai trạng thái trên.
- D: bỏ runner/phân loại/allowlist/hướng dẫn Fast Lane (382 dòng mã và dữ liệu); bridge CLI từ chối `pilot/run/quota-drill/activate` với `LEGACY_NEW_DISPATCH_DISABLED`, `resume` đòi packet có `state.json`; `recover` đòi chủ claim và lý do. Vẫn có `inspect`, `reconcile`, `status`, `report`. Commit trước thay đổi giữ nguồn lịch sử. Không xóa packet hoặc worktree.
- E1-E3: sau sửa theo review, Node 105/105, PowerShell 57/57, Python smoke exit 0; chỉ môi trường giả, không gọi tài khoản AI thật.
- E4: sau sửa theo review, `git diff --check` exit 0; 26 liên kết Markdown nội bộ, 0 thiếu.
- E5: sau sửa theo review, còn nguyên `MAX_PACKET_TEXT = 256 * 1024` và ca thử 256 KiB + 1 còn nguyên; Direct vẫn kiểm tra reviewer Luna Max, giới hạn `max_rework = 2`, khóa task/config, lọc bí mật và checkpoint Owner. `prepare` mới từ chối FAST/V2/LOCAL_AUTO; `check/status` của hồ sơ cũ không đổi.
- Phạm vi: chỉ kho Trạm Điều Phối AI; dự án khác không thay đổi. Không gọi tài khoản thật, không xóa packet.
- Quyết định đã chốt: giữ khả năng tiếp tục tác vụ cũ; bỏ LOCAL_AUTO khỏi luồng hiện tại. Direct vẫn là đường việc mới.
- Review c211da1: NEEDS_FIX — `resume` thiếu state có thể khởi tạo mới, `recover` thiếu operator, HANDOFF ghim checklist tạm thời. Đã sửa và review lại trên commit `4affed8` với kết quả PASS.
- E6: reviewer độc lập PASS trên đúng commit mã `4affed84c6fdc01a551cf418c99fc2c09e4da901`, đối chiếu từ nền `fc5c5bc`; không còn phát hiện quan trọng. Lần đầu `c211da1` là NEEDS_FIX, đã sửa và review lại.
- E7: đã báo Owner phần bỏ, phần giữ, kết quả và giới hạn chưa gọi AI thật trong cập nhật của đợt này.
- Hotfix theo yêu cầu Owner sau bài thử đăng nhập: trước khi đóng băng task mới, Lead đối chiếu gate với hành vi, trường hợp sai có thể xảy ra và câu chữ Owner thực sự yêu cầu; `repairs` đếm lượt Gemini sửa thực tế, `change_requests` đếm yêu cầu của Luna. Trường hợp 2 lượt Gemini và 2 yêu cầu sửa phải báo `repairs=1`, `change_requests=2`.
- Hợp đồng phiên bản 3 thay phiên bản 2 cho hotfix này. Review PASS của commit `4affed8` chỉ áp dụng cho nguồn cũ; E6 mở lại cho commit mã mới. Bộ kiểm tra Node 105/105, PowerShell 57/57 và Python smoke exit 0 đã chạy sau hotfix; chưa gọi tài khoản AI thật.
- Reviewer độc lập đã chỉ ra trường hợp Gemini hoàn thành nhưng hậu kiểm BLOCKED chưa tăng `attempt`, và vị trí ghi checklist trước `prepare` chưa tồn tại. Đã sửa cả hai; test Direct thất bại trước khi sửa và đạt sau khi sửa cho trường hợp đếm lượt, rồi chạy lại Node 105/105, PowerShell 57/57, Python smoke exit 0; `git diff --check` sạch.
- E6 hotfix: reviewer độc lập PASS trên đúng commit `3a24bd09641b28e1472b2a867f21c1763bf07449` so với `7f4892b`, chạy lại Direct 4/4 và kiểm tra diff sạch. Chưa gọi tài khoản AI thật. Review cũ trên `4affed8` giữ làm bằng chứng lịch sử.
- Commit mã đã review: `3a24bd09641b28e1472b2a867f21c1763bf07449`.
- E9: Owner cho phép gộp riêng ngày 2026-09-24; `main` đã nhận hotfix tại `ebc9caa` rồi Luna 6 Max tại `03db242`; đã xác minh hai commit là tổ tiên của `main` và Git sạch sau gộp.
- Commit đích sau gộp: `03db2420e215e81ac8ea86986d4f46a1ea709701`.
- Trở ngại/người xử lý tiếp: E8 còn trống vì chưa có lời nghiệm thu riêng cho toàn bộ checklist tinh gọn vận hành. Packet `.workflow-local/workflow-operation-simplification/` bị Git ignore; cần giữ hoặc chuyển riêng trước khi dọn worktree.
