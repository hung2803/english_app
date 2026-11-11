# Phase 1 — Toàn bộ chức năng bản đầu

Nguồn: `app-hoc-tieng-anh-ai-requirements.md`. Phase 1 gồm **toàn bộ** yêu cầu trong phạm vi bản đầu (mọi mức ưu tiên): test → lộ trình → buổi học → luyện tập → quiz → ôn từ vựng → tiến độ → điều chỉnh cuối tuần → thông báo → tài liệu tải lên.

## Phân tích phạm vi

| Nhóm | Yêu cầu | Ưu tiên | Phase |
|---|---|---|---|
| Đăng nhập | Một mật khẩu, không khóa | Cốt lõi | 1 |
| Kiểm tra trình độ | Trắc nghiệm 15–20 câu → CEFR | Cốt lõi | 1 |
| Lộ trình | AI lập khung 12 tuần / 60 buổi | Cốt lõi | 1 |
| Lộ trình | Điều chỉnh cuối tuần + duyệt | Cao | 1 |
| Lộ trình | Lỡ buổi tự dời sang ngày kế | Cao | 1 |
| Buổi học | AI tìm 2–3 tài liệu, chọn 1 | Cốt lõi | 1 |
| Buổi học | AI soạn bài (link, tóm tắt, giải thích VN, từ vựng, ngữ pháp) | Cốt lõi | 1 |
| Buổi học | Fallback AI tự viết bài | Cốt lõi | 1 |
| Buổi học | Tải tài liệu riêng (PDF/link) | Trung bình | 1 |
| Luyện tập | Chat/viết với AI, AI sửa lỗi, lưu lịch sử theo buổi | Cao | 1 |
| Luyện tập | Nút nghe phát âm | Trung bình | 1 |
| Luyện tập | Quiz cuối buổi, chấm tự động, <70% chưa đạt | Cốt lõi | 1 |
| Từ vựng | Tự thêm flashcard + SRS 5 phút đầu buổi | Cao | 1 |
| Tiến độ | Chuỗi ngày, xong/tổng, số từ, lịch sử, biểu đồ điểm | Cao/TB | 1 |
| Thông báo | Push trình duyệt nhắc học | Thấp | 1 |
| Thông báo | Email tổng kết tuần | Thấp | 1 |
| Ngoài phạm vi | Mic, chấm phát âm, offline flashcard, xuất CSV, nhiều user | — | Sau |

## Checklist theo nghiệp vụ

### A. Hạ tầng & nền tảng
- [x] Khung dự án: Cloudflare Worker (Hono) + D1 + React/Vite/Tailwind
- [x] Schema D1 + migration (3 file trong `migrations/`, chạy bằng `npm run db:migrate:local` / `db:migrate:remote`)
- [x] Cấu hình secrets (`GEMINI_API_KEY`, `APP_PASSWORD`, `SESSION_SECRET`, khóa email, khóa VAPID): xem `docs/SECRETS.md`; người dùng tự điền các khóa còn trống trong `.dev.vars`
- [x] Script dev / build / deploy / migrate
- [x] Giao diện tiếng Việt, responsive (desktop + điện thoại)
- [x] Xử lý lỗi AI thống nhất: thông báo + cho thử lại khi API từ chối

### B. Đăng nhập
- [x] Màn hình nhập mật khẩu duy nhất (giao diện + cổng vào app; API đăng nhập làm ở các mục dưới)
- [x] Cookie phiên ký HMAC, hạn 30 ngày
- [x] Không khóa khi nhập sai
- [x] Mọi API khác yêu cầu đăng nhập; đăng xuất

### C. Kiểm tra trình độ
- [x] Ngân hàng 15–20 câu (từ vựng, ngữ pháp, đọc hiểu), ~10 phút
- [x] Chấm phía server (đáp án không lộ cho client)
- [x] Xếp CEFR A0/A1/A2/B1
- [x] Lưu kết quả + ngày làm
- [x] Làm lại sau 12 tuần để đo tiêu chí thành công (so mức CEFR đầu và hiện tại)

### D. Lộ trình
- [x] AI lập khung chủ đề 12 tuần theo mức CEFR (fallback bộ chủ đề mặc định khi AI lỗi)
- [x] Sinh 60 buổi, 5 buổi/tuần, thứ 2–thứ 6
- [x] Màn hình xem lộ trình theo tuần + trạng thái buổi (chưa học / xong / bị lỡ)
- [x] Lỡ buổi: tự dời sang ngày kế, các buổi sau lùi theo, ngày kết thúc muộn hơn
- [x] Hết lộ trình: bắt buộc test lại (mỗi lần xét phải là bài test mới)
- [x] Đạt = đúng 100% câu ở mọi mức từ A0 tới mức kế tiếp của lộ trình (vd lộ trình A1 → A0, A1, A2)
- [x] Đạt → AI lập lộ trình mới theo mức mới; lộ trình cũ lưu trữ
- [x] Chưa đạt → KHÔNG tạo lộ trình mới; AI thêm 2 tuần ôn tập (10 buổi) theo mức yếu + từ hay sai, học xong test lại, lặp tới khi đạt

### E. Điều chỉnh lộ trình cuối tuần
- [x] Phát hiện "buổi thứ 5 của tuần vừa xong" → kích hoạt AI (`worker/weekly.ts`, nối vào bước nộp quiz)
- [x] AI đọc điểm quiz + từ hay sai → tạo đề xuất thay đổi chủ đề các tuần sau (`worker/adjustment.ts`; chưa lưu, việc lưu là mục kế tiếp)
- [x] Lưu đề xuất với trạng thái chờ duyệt / đã duyệt / bỏ qua (`worker/adjustment-store.ts`; thêm trạng thái `no_change` khi AI thấy không cần đổi)
- [x] Màn hình duyệt trong app: xem đề xuất, duyệt hoặc từ chối (`/adjustments`)
- [x] Chỉ áp dụng khi duyệt; không duyệt thì giữ lộ trình cũ

### F. Buổi học
- [x] Bắt đầu buổi: AI tìm 2–3 tài liệu (web / YouTube phụ đề / podcast có transcript) (`worker/materials.ts`, `POST /api/sessions/:id/materials`)
- [x] Kiểm tra link hợp lệ trước khi đưa cho người học (`worker/link-check.ts`; YouTube chưa xác nhận được có phụ đề)
- [x] Chọn 1 tài liệu; khóa, không đổi giữa buổi (`POST /api/sessions/:id/choose` + trigger CSDL `0006_material_lock.sql`)
- [x] Soạn bài ≤ 60 giây: link nguồn + đoạn trích, tóm tắt & giải thích tiếng Việt, từ vựng + ngữ pháp (`worker/lesson.ts`, `POST /api/sessions/:id/compose`; quiz sẽ thêm vào cùng lần gọi AI ở nhóm I)
- [x] Thanh tiến trình, thông báo + thử lại khi lỗi (`src/components/AiStep.tsx`, `AiProgress`; trang `/session/:id` mới tới bước hiện bài học)
- [x] Fallback: không tìm được tài liệu / tìm kiếm lỗi → AI tự viết bài, ghi rõ "do AI viết" (API từ chối thì không fallback mà báo lỗi + thử lại)
- [x] Chỉ lưu link + đoạn trích ngắn (danh sách ≤ 40 từ, bài học ≤ 80 từ; `worker/storage.test.ts` kiểm tra toàn bộ CSDL)
- [x] Nội dung buổi chỉ soạn khi người học bắt đầu buổi đó (`worker/on-demand.test.ts`)

### G. Tài liệu tải lên
- [x] Tải lên PDF / sách / link từ người học (`POST /api/uploads`, `POST /api/uploads/link`; nhận PDF, TXT, MD — chưa hỗ trợ EPUB)
- [x] Lưu file (R2) hoặc trích văn bản; giới hạn kích thước (R2 `FILES`, tối đa 10 MB, chống trùng bằng SHA-256)
- [x] AI phân tích tài liệu, đưa vào buổi học như một lựa chọn ở bước chọn tài liệu (`worker/upload-material.ts`, `composeFromUpload` trong `worker/lesson.ts`)
- [x] Danh sách tài liệu đã tải; xóa được (`GET /api/uploads`, `DELETE /api/uploads/:id`, trang `/uploads`)

### H. Luyện viết / hội thoại với AI
- [x] Khung chat chữ trong buổi học, AI hội thoại theo chủ đề và trình độ (`worker/chat.ts`, `src/components/Chat.tsx`)
- [x] AI sửa lỗi câu người học viết (kèm giải thích tiếng Việt) (cùng lần gọi AI với câu trả lời; `normalizeCorrection` trong `worker/chat.ts`)
- [x] Lưu lịch sử chat theo buổi (bảng `chat_messages`; `worker/chat-history.test.ts`)
- [x] Mở lại buổi cũ xem được chat (bấm buổi đã xong ở trang Lộ trình → "Xem lại"; chat chỉ xem)

### I. Quiz cuối buổi
- [x] Trắc nghiệm + điền từ (8 câu) do AI soạn cùng bài (`worker/quiz.ts`; cùng lần gọi AI với bài học, đáp án chỉ ở máy chủ; chưa có màn hình làm quiz)
- [x] Chấm tự động phía server, hiển thị đáp án + giải thích (`POST /api/sessions/:id/quiz`, `src/components/Quiz.tsx`; nộp một lần, chốt buổi)
- [x] <70% = chưa đạt nhưng buổi vẫn xong, đánh dấu buổi xong (cùng bước nộp quiz)
- [x] Câu sai → từ liên quan vào hàng ôn ngay (khi nộp quiz: đặt lại như "Quên", đến hạn hôm nay; từ chưa có thì thêm vào kho)
- [x] Điểm thấp được lưu để AI dùng khi điều chỉnh cuối tuần (điểm trong `sessions.score`, từ sai trong `result_json` + `vocab.wrong_count`; `worker/low-scores.test.ts`)
- [x] Sau khi đánh dấu buổi xong: gọi `dispatchWeeklyReview` (chạy nền bằng `waitUntil`) để kích hoạt điều chỉnh cuối tuần (`worker/quiz-dispatch.test.ts`)

### J. Từ vựng & flashcard
- [x] Từ vựng của buổi học tự thêm vào kho (không trùng) (nạp cùng giao dịch lưu bài ở `composeSession`; ôn lần đầu hẹn ngày mai; `worker/vocab-auto.test.ts`)
- [x] Ôn flashcard SRS đầu buổi (~5 phút), 4 mức đánh giá (`worker/srs.ts`, `src/components/Flashcards.tsx`, bước ôn ở đầu trang buổi học, trang `/review`)
- [x] Tự tính thẻ đến hạn; đánh dấu "đã thuộc" (`GET /api/flashcards/due`, đã thuộc khi khoảng cách ôn ≥ 21 ngày)
- [x] Trang kho từ vựng + tìm kiếm (`/vocab`, `GET /api/vocab`: tìm không cần dấu, lọc, phân trang)
- [x] Nút nghe phát âm cho từ và câu (Web Speech API) (`Speak` ở thẻ, kho từ vựng, bài học)

### K. Tiến độ
- [x] Chuỗi ngày học (`worker/streak.ts`: chuỗi hiện tại + dài nhất, chỉ tính T2–T6)
- [x] Buổi xong / tổng theo tuần và toàn lộ trình; tỉ lệ hoàn thành (mục tiêu ≥ 80%) (`GET /api/progress`, trang `/progress`)
- [x] Số từ đã học / đã thuộc
- [x] Biểu đồ điểm quiz theo thời gian (`src/components/ScoreChart.tsx`, có bảng số liệu thay thế)
- [x] Lịch sử buổi học: mở lại tài liệu, từ vựng, quiz; tìm theo chủ đề (`GET /api/history`, trang `/history`)

### L. Thông báo
- [x] Cài đặt giờ nhắc (mặc định 20:00, đổi được) — `worker/settings.ts`, `src/pages/Settings.tsx`
- [x] Đăng ký thông báo đẩy trình duyệt (service worker + VAPID) — `public/sw.js`, `src/push.ts`, `worker/webpush.ts`
- [x] Cron Trigger gửi nhắc thứ 2–thứ 6; bỏ qua nếu hôm đó đã học xong — `worker/reminders.ts`, `worker/cron.ts` (mỗi 10 phút)
- [x] Chọn dịch vụ gửi email miễn phí (vd Resend) + cấu hình — Resend, `worker/email.ts`, `docs/SECRETS.md`
- [x] Email tổng kết tuần kèm đề xuất điều chỉnh, gửi ngay sau buổi thứ 5; link mở màn hình duyệt trong app — `worker/weekly-run.ts`, link `${APP_URL}/adjustments`

### M. Kiểm thử & bàn giao
- [ ] Typecheck + build sạch
- [ ] Test logic thuần (dời buổi, SRS, chấm điểm, chuỗi ngày, xếp CEFR)
- [ ] Test luồng điều chỉnh cuối tuần (duyệt / không duyệt)
- [ ] Chạy thử end-to-end với Gemini key thật
- [ ] Kiểm tra trên điện thoại (responsive, push)
- [ ] Deploy lên Cloudflare (tạo D1, secrets, cron)

## Ghi chú rủi ro
- Push trên iPhone chỉ chạy khi cài web app vào màn hình chính (PWA).
- Cloudflare không có dịch vụ email gửi đi miễn phí đủ dùng → cần dịch vụ ngoài (Resend free tier) cho email tuần.
- Link AI tìm có thể sai/chết → luôn kiểm tra link trước khi hiển thị, có fallback AI viết bài.
