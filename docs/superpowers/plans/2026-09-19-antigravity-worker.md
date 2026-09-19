# Kế hoạch triển khai Gemini trong Antigravity — 2026-09-19

Owner đã duyệt kế hoạch trong chat bằng “tiến hành”.
For agentic workers: dùng superpowers:executing-plans cho từng nhiệm vụ đã giao. Điều phối mở task theo HANDOFF; không tự phân nhánh thêm agent.

## Mục tiêu và kiến trúc được duyệt

Owner → Điều phối → Gemini 3.8 Flash High trong Antigravity → kiểm tra → reviewer độc lập → sửa có giới hạn → Owner duyệt kết quả cuối.
Dùng lại Node.js và cầu nối Python hiện có, ba thao tác execute/continue/result. Bản đầu chạy trên bản sao thử nghiệm không có dữ liệu nhạy cảm. Không coi worktree là cách ly hệ điều hành.
Worker sản phẩm: gemini-3.8-flash-high. Reviewer Terra High, phiên độc lập. Nhóm xây công cụ: Implement Luna Max, reviewer Terra High.
Một writer, tối đa bốn vòng sửa sau lượt đầu, không reset hạn mức bằng đổi task. Lỗi tài khoản/quota/quyền/kết nối dừng để xử lý, không tự chuyển model/API trả phí. Bản đầu không tự fallback Luna/senior.
Tạm dừng SDK/C#/Windows service; không tự merge/push/triển khai hoặc thay dữ liệu thật. Các task cũ không tự đổi policy.

## 1. AG-PROBE-001 — chứng minh gọi đúng model

- [ ] Đọc HANDOFF, AGENTS, canonical spec, bootstrap; chỉ đọc phần code liên quan trong mcp/antigravity_server.py và scripts/lib/implementation-worker.mjs.
- [ ] Kiểm tra agy help/models và khả năng dùng sandbox + plan mode không bỏ qua quyền. Không đọc hoặc in credential.
- [ ] Tạo thư mục thử nghiệm riêng ngoài repo nguồn, không sao chép dữ liệu dự án/credential. Ghi đúng đường dẫn trong báo cáo.
- [ ] Gọi đúng executable C:\Users\QQ\AppData\Local\agy\bin\agy.exe, model gemini-3.8-flash-high; dùng --sandbox, --mode plan, --output-format stream-json, giới hạn 60 giây bằng khả năng đã xác minh. Prompt chỉ yêu cầu trả lời một chuỗi xác nhận, không dùng tool, không đọc/sửa file, không gọi mạng qua tool.
- [ ] Ghi argv không chứa bí mật, exit code, trạng thái kết thúc, model thực sự báo về, conversation id nếu có, kết quả và thời gian. Metadata thiếu/sai phải ghi chưa xác minh, không suy từ model yêu cầu.
- [ ] Nếu sandbox/quyền/auth không dùng được: dừng lượt thật, không bỏ sandbox hoặc chuyển sang dangerously-skip-permissions; ghi blocker cụ thể. Không thử lại nếu chưa biết lượt trước đã dừng.
- [ ] Ghi docs/ANTIGRAVITY_PROBE_REPORT.md bằng tiếng Việt và mục 5 HANDOFF. Không sửa source/config/chốt an toàn trong nhiệm vụ này.
Nghiệm thu: bằng chứng trả lời thật + đúng model, hoặc blocker tái hiện được; danh sách model không phải bằng chứng chạy thành công. Reviewer kiểm tra bằng chứng và repo diff, không cần tiêu thụ thêm lượt thật nếu không có nghi vấn cụ thể.

## 2. Nối worker vào điều phối — chỉ giao sau khi nghiệm thu bước 1

- [ ] Đối chiếu policy hiện hành và đường gọi thực tế; cập nhật canonical spec cho chế độ local trial, không nới task đã frozen. Chuẩn bị phiếu giao việc cụ thể trước sửa.
- [ ] Trong mcp/antigravity_server.py và scripts/lib/implementation-worker.mjs: truyền model đã xác minh, giữ operation/task correlation, phân biệt requested/observed identity; giữ execute/continue/result.
- [ ] Thêm chế độ local trial tường minh với root thử nghiệm được chỉ định; không dùng test_mode để gọi thật, không xóa guard toàn cục. Không cho trial chạy tại root code/điều khiển hoặc thư mục có dữ liệu nhạy cảm.
- [ ] Giữ timeout, giới hạn output, che secret; xác định process đã dừng trước retry. Không tự bỏ qua quyền.
- [ ] Viết kiểm tra nhỏ trong suite hiện có cho model argv, trial/fixture/blocked modes, đường dẫn ngoài root, sai/thiếu metadata, timeout, kết quả sai task và trùng operation; chạy các kiểm tra liên quan.
- [ ] Thử một việc sửa file nhỏ trên bản sao dùng dữ liệu giả; kiểm tra diff và kết quả thực tế rồi giao reviewer độc lập.

## 3. Vòng làm/review/sửa tự động

- [ ] Dùng state/receipt/budget hiện có; thêm policy trial rõ ràng nếu cần, không tạo bộ điều phối song song.
- [ ] Gemini làm → test → Terra High review đúng bản → Gemini sửa. Tối đa bốn vòng, một writer; code đổi làm review cũ hết hiệu lực.
- [ ] Kiểm tra duplicate, resume sau gián đoạn, quota/auth/timeout, reviewer không khả dụng, hết budget. Không tự fallback, không xem exit 0 là nghiệm thu.
- [ ] Chạy một nhiệm vụ thử nghiệm trọn vòng, có một lỗi reviewer trả lại và sửa được; báo đúng model được quan sát.

## 4. Nghiệm thu và bàn giao

- [ ] Owner nhận báo cáo Việt ngữ: thay đổi, test/review, giới hạn, bản chờ duyệt; không cần chuyển lời giữa agent khi sản phẩm chạy.
- [ ] Giữ HANDOFF gọn, lưu lịch sử riêng; lưu mốc khôi phục sau kiểm tra đạt, không merge/push.
- [ ] Phân biệt quy trình sản phẩm tự chạy với các task xây công cụ được điều phối giao từng bước trong chat hiện tại.

## Giới hạn chứng cứ và rủi ro

Sandbox Antigravity phải được khảo sát, không giả định bảo vệ toàn máy. Bản đầu chỉ trial, không dữ liệu nhạy cảm. H-021 vẫn mở đến khi có bằng chứng phù hợp; không tuyên bố production-ready. Chưa biết định dạng metadata/capability thực tế thì bước 1 trả bằng chứng để chốt bước 2, không tự đoán interface.
