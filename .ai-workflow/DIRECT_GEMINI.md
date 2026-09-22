# Gọi Gemini trực tiếp

Điều phối chuẩn bị yêu cầu rồi chạy script; không mở Luna chỉ để chạy lệnh. Worker dùng Gemini 3.8 Flash High qua MCP Antigravity đã đăng nhập để thực hiện (Gemini implement), controller tự chạy kiểm tra/gate (controller tests), reviewer độc lập bắt buộc là OpenAI Codex model `gpt-5.6-luna` ở reasoning effort `max` (Luna Max independent review), sau đó dừng tại checkpoint chờ Owner nghiệm thu (Owner acceptance). Luna chỉ làm reviewer độc lập, tuyệt đối không làm worker hay runner. Không cài thêm dịch vụ hoặc thư viện.

## Quy trình

1. Dùng task `qq.workflow.task.v10.1` và config `qq.bridge.v2` hiện có; chốt repo chính, base SHA, mục tiêu, tiêu chí, exact `allowed_paths`/`write_paths` và gates. Owner chỉ cần mô tả công việc. Điều phối soạn JSON.
2. Config worker: `transport:mcp`, `server:antigravity_worker`, `provider:mcp`, `command:[python,mcp/antigravity_server.py]`, `model:gemini-3.8-flash-high`, `local_trial:true`, `local_trial_root` là thư mục tuyệt đối nằm ngoài repo/packet, `skip_permissions:false`. Reviewer: `provider:openai`, `cli:codex`, `command:[codex]`, `model:gpt-5.6-luna`, `effort:max`. Direct preflight không còn yêu cầu hoặc đọc định nghĩa agent Gemini no-tools, kiểm tra thuê bao Antigravity và quyền ghi tạm thời của worker vẫn giữ nguyên. Billing `SUBSCRIPTION_ONLY`; không chấp nhận `fallback_reviewer`.
3. Chạy `prepare`, rồi `check`; hai lệnh này không gọi model. `prepare` tạo task/lock và helper dưới `.workflow-local/direct/<task_id>`, packet bên ngoài repo, giữ nguyên trạng thái paused/stopped. Chỉ hỗ trợ repo chính, không dùng một worktree làm repo nguồn. Thêm `.workflow-local/` vào ignore của repo trước khi chuẩn bị.
4. Chạy `run` đúng một lần. Tối đa hai lượt worker và hai lượt reviewer, chỉ một repair trong cùng tiến trình. Worker Gemini thực hiện (Gemini implement), controller tự chạy gate (controller tests), và OpenAI Codex Luna Max kiểm tra độc lập (Luna Max independent review). Worker chỉ dùng file tools trên file được giao.
5. Đọc JSON kết quả trước; khi lỗi mới mở evidence. `WAITING_FOR_CHECKPOINT` nghĩa là kiểm tra đã đạt và đang chờ Owner nghiệm thu (Owner acceptance). Quota/auth/permission/guard/crash dừng; không chạy lại hoặc tạo task mới để né ngân sách.
6. Sau khi Owner nói rõ nghiệm thu, Điều phối chạy `accept ... Owner`. Script ghi checkpoint/completion; không tự chép file về repo nguồn hoặc commit. Muốn chuyển kết quả phải so baseline và chỉ chuyển file đã duyệt. Sau đó lưu mốc khôi phục kèm mã nguồn, config không bí mật và evidence; không lưu settings/auth.

## Cú pháp PowerShell

Đứng tại thư mục mã nguồn Trạm Điều Phối AI. Các biến bên dưới do Điều phối điền bằng đường dẫn thực tế; Owner không phải tự sửa lệnh. Hai file đầu vào dùng đúng schema đang có, không thêm schema yêu cầu mới.

```powershell
node scripts/direct.mjs prepare $repo $taskJson $configJson $newOutput
node scripts/direct.mjs check "$newOutput/prepared.json"
node scripts/direct.mjs run "$newOutput/prepared.json"
node scripts/direct.mjs status "$newOutput/prepared.json"
# Chỉ sau xác nhận nghiệm thu của Owner:
node scripts/direct.mjs accept "$newOutput/prepared.json" Owner
```

Mỗi lần chạy tạo báo cáo UUID riêng và một `dispatch.json` chống chạy lặp. Báo cáo chỉ chứa model/session, gate, số dispatch có bằng chứng, cleanup và vị trí evidence; số lần gọi nội bộ provider không biết thì ghi unknown. Không suy đoán token tiết kiệm. Tổng dispatch tối đa không bao gồm lượt review mã công cụ, phải ghi hai ngân sách riêng.

Chỉ một tác vụ được ghi quyền tài khoản trên máy tại một thời điểm. Đóng cưỡng bức có thể bỏ qua cleanup: giữ packet, xác minh worker đã dừng, đối chiếu đúng quyền tạm; không ghi đè toàn bộ settings hoặc tự chạy lại. Không sửa thư mục RESTORE. Các runner R2/WEB cũ là bằng chứng lịch sử, không phải điểm chạy mặc định.

Nếu Gemini reviewer không gọi được, Điều phối ghi lý do và kiểm tra số lượt còn lại trước khi dùng Terra High theo chính sách. Không dùng fallback cho kết quả NEEDS_FIX, không tự mở phiên Luna.
