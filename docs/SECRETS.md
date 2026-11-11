# Cấu hình secrets

Không commit secrets. `.dev.vars` đã nằm trong `.gitignore`.

| Khóa | Dùng cho | Lấy ở đâu |
|---|---|---|
| `GEMINI_API_KEY` | Gọi Gemini (tìm tài liệu, soạn bài, chat) | https://aistudio.google.com/apikey; model chọn bằng biến thường `GEMINI_MODEL` trong wrangler.toml, mặc định gemini-3.5-flash-lite |
| `APP_PASSWORD` | Mật khẩu đăng nhập duy nhất | Bạn tự đặt |
| `SESSION_SECRET` | Ký cookie phiên | Tự tạo bằng `npm run secrets:init` |
| `RESEND_API_KEY` | Gửi email tổng kết tuần | https://resend.com (gói free) |
| `EMAIL_FROM` | Địa chỉ gửi | Mặc định `onboarding@resend.dev` (chỉ gửi được tới email đã đăng ký Resend); dùng domain riêng nếu muốn gửi tới nơi khác |
| `EMAIL_TO` | Địa chỉ nhận email tuần | Email của bạn |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Thông báo đẩy trình duyệt | Tự tạo bằng `npm run secrets:init` |
| `VAPID_SUBJECT` | Liên hệ gắn với khóa VAPID | `mailto:` + email của bạn |
| `APP_URL` | Link trong email | Local: `http://localhost:5173`; production: URL Worker |

## Local

```
npm run secrets:init      # tạo .dev.vars, tự sinh SESSION_SECRET + cặp VAPID, không ghi đè giá trị có sẵn
```
Sau đó mở `.dev.vars` điền `GEMINI_API_KEY`, `APP_PASSWORD`, `RESEND_API_KEY`, `EMAIL_TO`, `VAPID_SUBJECT`.
Script chạy lại nhiều lần vẫn an toàn.

## Production (Cloudflare)

Đẩy toàn bộ khóa trong `.dev.vars`, nhưng đặt `APP_URL` thành URL production trước:
```
npx wrangler secret bulk .dev.vars
```
Hoặc từng khóa: `npx wrangler secret put GEMINI_API_KEY`.

`VAPID_PUBLIC_KEY` cũng cần đưa cho trình duyệt khi đăng ký push (không phải bí mật; app lấy qua `GET /api/push/key`).
Đổi cặp VAPID sau khi đã có thiết bị đăng ký sẽ làm các đăng ký cũ hỏng.

## Thông báo — lưu ý
- Nhắc học chạy bằng Cron Trigger mỗi 10 phút (`wrangler.toml`): gửi thứ 2–thứ 6, một lần/ngày, trong 90 phút sau giờ đặt, bỏ qua nếu đã học xong. Cron cũng thử lại tuần chưa chấm và email chưa gửi.
- `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`, `APP_URL` đều cần cho email; `APP_URL` là địa chỉ app (link trong email trỏ tới `/adjustments`). Thiếu một biến → bỏ qua email, app vẫn dùng bình thường.
- Với `onboarding@resend.dev`, Resend chỉ gửi được tới email chủ tài khoản.
- Push cần HTTPS (hoặc localhost). iPhone/iPad: phải thêm app vào Màn hình chính rồi mở từ đó mới bật được.
