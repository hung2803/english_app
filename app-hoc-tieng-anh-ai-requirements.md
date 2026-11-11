# App học tiếng Anh tích hợp AI — Danh sách yêu cầu

> Hạt giống ban đầu: "tôi muốn xây dựng áp để quản lý việc học tiếng Anh bằng phương pháp tích hợp AI đề xuất việc học à lộ trình học cho người mới bắt đầu và nguồn tài liệu sẽ được AI tìm kiếm và phân tích cho mỗi buổi học"
> Trạng thái: Hoàn tất — 2026-11-11

## 1. Tổng quan
- Bối cảnh: Hiện đang tự học rời rạc (YouTube, sách, web…), không có lộ trình và không theo dõi được tiến độ. Làm mới, không thay thế hệ thống nào.
- Mục tiêu: Giao tiếp cơ bản hằng ngày; lộ trình từ A0 lên khoảng A2–B1, cân bằng nghe, nói, đọc, viết.
- Tiêu chí thành công: sau 3 tháng (12 tuần), làm lại bài test trình độ đạt mức CEFR cao hơn ban đầu 1 bậc; và hoàn thành ≥ 80% số buổi (ít nhất 48/60 buổi).

## 2. Phạm vi
- Trong phạm vi (bản đầu):
  - Kiểm tra trình độ đầu vào và lộ trình học do AI tạo.
  - Buổi học do AI soạn: AI tìm tài liệu trên web, phân tích và soạn thành bài học.
  - Bài tập sau buổi học và ôn từ vựng.
  - Theo dõi tiến độ; AI điều chỉnh lộ trình theo kết quả.
- Ngoài phạm vi:
  - Luyện nói bằng mic (giai đoạn sau).
  - Chấm phát âm (giai đoạn sau).
  - Ôn flashcard khi offline (giai đoạn sau).
  - Xuất từ vựng ra file CSV (giai đoạn sau).
  - Nhiều người dùng / chia sẻ (không có đăng ký, bạn bè, bảng xếp hạng).
- Tiền đề và ràng buộc: người dùng đã có gói Gemini Pro kèm API. Ngân sách: ưu tiên miễn phí vì đây là app cá nhân.

## 3. Người dùng và phân quyền
| Vai trò | Mô tả | Được phép | Không được phép |
|---|---|---|---|
| Chủ app (người học) | Người dùng duy nhất | Toàn bộ chức năng | — |

- Phạm vi dữ liệu: chỉ một người dùng, không cần phân quyền.

## 4. Luồng nghiệp vụ chính
Bắt đầu học:
1. Người học làm bài trắc nghiệm đầu vào 15–20 câu → hệ thống xếp mức CEFR (A0/A1/A2/B1).
2. Hệ thống (AI) lập khung lộ trình với chủ đề theo từng tuần → người học xem lộ trình.

Buổi học:
1. Người học mở buổi học → hệ thống cho ôn flashcard đến hạn khoảng 5 phút.
2. AI tìm tài liệu và đưa 2–3 lựa chọn → người học chọn 1.
3. AI soạn bài (tối đa 60 giây, có thanh tiến trình) → hiển thị link nguồn, tóm tắt và giải thích tiếng Việt, từ vựng + ngữ pháp rút ra.
4. Người học luyện viết / hội thoại bằng chữ với AI → AI sửa lỗi.
5. Người học làm quiz cuối buổi → hệ thống chấm điểm tự động, đưa câu sai vào ôn, đánh dấu buổi xong.

Điều chỉnh cuối tuần:
1. Ngay sau buổi thứ 5 của tuần, AI xem điểm quiz và từ hay sai → gửi email tổng kết kèm đề xuất thay đổi lộ trình.
2. Người học duyệt trong app → hệ thống áp dụng thay đổi; không duyệt thì giữ lộ trình cũ.

- Trạng thái của buổi học: chưa học / đã xong / bị lỡ (dời sang ngày kế).

## 5. Yêu cầu chức năng
| Nhóm | Yêu cầu | Ưu tiên |
|---|---|---|
| Kiểm tra trình độ | Người học làm trắc nghiệm 15–20 câu (từ vựng, ngữ pháp, đọc hiểu), khoảng 10 phút; hệ thống xếp mức CEFR A0/A1/A2/B1 | Cốt lõi |
| Lộ trình | AI lập khung chủ đề theo từng tuần cho cả lộ trình dựa trên mức CEFR và mục tiêu giao tiếp cơ bản | Cốt lõi |
| Lộ trình | Cuối mỗi tuần AI đề xuất điều chỉnh dựa trên điểm quiz và từ hay sai; chỉ áp dụng sau khi người học duyệt | Cao |
| Lộ trình | Buổi bị lỡ tự dời sang ngày kế tiếp, các buổi sau lùi theo | Cao |
| Buổi học | Khi người học bắt đầu buổi, AI tìm tài liệu (web, YouTube, podcast, tài liệu tải lên) và đưa 2–3 lựa chọn để chọn 1 | Cốt lõi |
| Buổi học | AI soạn bài từ tài liệu đã chọn: link nguồn + đoạn trích ngắn, tóm tắt và giải thích tiếng Việt, từ vựng + ngữ pháp rút ra | Cốt lõi |
| Buổi học | Không tìm được tài liệu hoặc tìm kiếm lỗi: AI tự soạn bài đọc và ghi rõ là do AI viết | Cốt lõi |
| Buổi học | Người học tải lên tài liệu riêng (PDF, sách, link) để AI phân tích và đưa vào buổi học | Trung bình |
| Luyện tập | Người học viết câu / chat bằng chữ với AI, AI sửa lỗi; lịch sử chat lưu theo buổi, mở lại buổi cũ thấy được | Cao |
| Luyện tập | Nút nghe phát âm cho từ và câu | Trung bình |
| Luyện tập | Quiz cuối buổi (trắc nghiệm, điền từ) chấm điểm tự động; dưới 70% là chưa đạt nhưng buổi vẫn xong, câu sai đưa vào ôn | Cốt lõi |
| Từ vựng | Từ vựng rút ra từ buổi học tự thêm vào kho flashcard | Cao |
| Từ vựng | Ôn flashcard lặp lại ngắt quãng khoảng 5 phút đầu mỗi buổi; hệ thống tự tính từ đến hạn | Cao |
| Tiến độ | Hiển thị chuỗi ngày học, số buổi xong/tổng buổi theo tuần và cả lộ trình | Cao |
| Tiến độ | Biểu đồ điểm quiz theo thời gian | Trung bình |
| Tiến độ | Số từ vựng đã học / đã thuộc | Trung bình |
| Tiến độ | Lịch sử buổi học: mở lại tài liệu, từ vựng, quiz của buổi cũ; tìm theo chủ đề | Trung bình |
| Thông báo | Thông báo đẩy trên trình duyệt nhắc học vào giờ cố định người học đặt trong app, thứ 2–thứ 6 (mặc định 20:00, đổi được); không nhắc nếu hôm đó đã học xong | Thấp |
| Thông báo | Email tổng kết tuần kèm đề xuất điều chỉnh lộ trình, gửi ngay sau buổi thứ 5 của tuần; duyệt trong app | Thấp |
| Đăng nhập | Vào app bằng một mật khẩu duy nhất; chỉ kiểm tra mật khẩu, không khóa khi nhập sai | Cốt lõi |

## 6. Dữ liệu chính
| Đối tượng | Thông tin quan trọng | Ghi chú |
|---|---|---|
| Kết quả test trình độ | Điểm, mức CEFR, ngày làm | Làm lại sau 12 tuần để đo tiêu chí thành công |
| Lộ trình | Chủ đề từng tuần, các đề xuất điều chỉnh và trạng thái duyệt | |
| Buổi học | Ngày, trạng thái, link nguồn + đoạn trích ngắn, phần AI soạn, điểm quiz | Không lưu toàn bộ nội dung gốc |
| Từ vựng (flashcard) | Từ, nghĩa, buổi học nguồn, lịch ôn, đã thuộc hay chưa | |
| Tài liệu tải lên | File/link do người học đưa | |

## 7. Quy tắc nghiệp vụ
- Nhịp học: mỗi buổi 30 phút, 5 buổi/tuần.
- Kiểm tra đầu vào: trắc nghiệm 15–20 câu, khoảng 10 phút, xếp mức CEFR A0/A1/A2/B1.
- Lộ trình: dài 12 tuần (60 buổi). AI lập khung chủ đề theo tuần; nội dung mỗi buổi chỉ được soạn khi người học bắt đầu buổi đó.
- Hết lộ trình: người học làm lại bài test trình độ. Chỉ được sang lộ trình mới khi bài test lại đúng 100% số câu ở MỌI mức từ A0 tới mức kế tiếp của lộ trình vừa học (vd lộ trình A1 → đúng hết A0, A1, A2). Chưa đạt thì KHÔNG tạo lộ trình mới: AI thêm 2 tuần ôn tập (10 buổi) vào cuối lộ trình, dựa trên mức yếu và từ hay sai; học xong lại test lại, lặp lại tới khi đạt. Mỗi lần xét phải là một bài test mới. (Thay đổi so với bản đầu, xác nhận ngày 2026-11-11.)
- Điều chỉnh lộ trình: đề xuất ngay sau buổi thứ 5 của tuần; chỉ áp dụng sau khi người học duyệt trong app; không duyệt thì giữ lộ trình cũ.
- Lỡ buổi: dời sang ngày kế tiếp, lộ trình lùi theo (ngày kết thúc muộn hơn).
- Nguồn tài liệu AI được dùng: bài viết / trang web miễn phí; video YouTube (dựa vào phụ đề); podcast / audio (nguồn có transcript); tài liệu người học tự tải lên.
- Chọn tài liệu: AI đưa 2–3 lựa chọn, người học chọn 1; đã vào buổi thì không đổi tài liệu.
- Lưu tài liệu: chỉ lưu link + đoạn trích ngắn dùng trong bài.
- Ôn từ vựng: flashcard lặp lại ngắt quãng, khoảng 5 phút đầu buổi, nằm trong 30 phút.
- Quiz cuối buổi: dưới 70% là chưa đạt; buổi vẫn tính là xong, câu sai đưa vào ôn; điểm thấp được AI dùng khi điều chỉnh cuối tuần.
- Lượng gọi AI: không giới hạn; khi API từ chối, app hiện thông báo và cho thử lại sau.

## 8. Yêu cầu phi chức năng
- Giao diện tiếng Việt (menu, nút, giải thích); nội dung học bằng tiếng Anh.
- Soạn một buổi học: chờ tối đa 60 giây, có thanh tiến trình.

## 9. Nền tảng, công nghệ và tích hợp
- Nền tảng: Web, dùng được trên trình duyệt máy tính và điện thoại.
- Dịch vụ AI: Google Gemini API (tìm kiếm web và soạn bài).
- Hosting: Cloudflare.
- Đăng nhập: mật khẩu đơn giản (một mật khẩu duy nhất), không khóa khi nhập sai.
- Thông báo: thông báo đẩy trên trình duyệt; email.

## Nhật ký phỏng vấn
- Vòng 1: Hỏi người dùng, chức năng bản đầu, hiện trạng, nền tảng → chỉ mình chủ app dùng; chọn cả 4 nhóm chức năng; đang tự học rời rạc; web responsive.
- Vòng 2: Hỏi mục tiêu học, thời lượng, nguồn tài liệu, cấu trúc buổi học → giao tiếp cơ bản hằng ngày; 30 phút × 5 buổi/tuần; cả 4 loại nguồn; buổi học gồm cả 4 phần.
- Vòng 3: Hỏi test đầu vào, dạng lộ trình, điều chỉnh, lỡ buổi → trắc nghiệm 15–20 câu xếp CEFR; khung theo tuần, buổi soạn khi tới ngày; điều chỉnh cuối tuần có duyệt; lỡ buổi thì dời sang ngày kế.
- Vòng 4: Hỏi chọn tài liệu, ôn từ vựng, chữ/giọng nói, ngưỡng quiz → AI đưa 2–3 lựa chọn; flashcard SRS đầu buổi; gõ chữ + nút nghe phát âm; dưới 70% vẫn xong buổi, câu sai vào ôn.
- Vòng 5: Hỏi dịch vụ AI, hosting/đăng nhập, nhắc học, màn hình tiến độ → Gemini API; Cloudflare + mật khẩu đơn giản; push trình duyệt + email tổng kết tuần; tiến độ gồm cả 4 mục.
- Vòng 6: Hỏi mặc định, ngân sách, tiêu chí thành công, ngoài phạm vi → giao diện tiếng Việt, chờ tối đa 60 giây, AI tự viết bài khi không có nguồn; đã có gói Gemini Pro kèm API; thành công = lên 1 bậc CEFR + ≥ 80% buổi sau 3 tháng; ngoài phạm vi: nhiều người dùng.
- Vòng 7: Làm rõ lưu tài liệu, phát âm, offline/xuất file, hạn mức AI → lưu link + đoạn trích ngắn; chấm phát âm, offline, xuất CSV để giai đoạn sau; không giới hạn lượng gọi AI.
- Vòng 8: Hỏi ưu tiên, độ dài lộ trình, giờ nhắc, mặc định → đồng ý cách xếp ưu tiên đề xuất; 12 tuần (60 buổi); nhắc giờ cố định thứ 2–thứ 6; lưu lịch sử chat theo buổi; KHÔNG xác nhận: email tối Chủ nhật, đổi tài liệu giữa buổi, khóa sau 5 lần sai mật khẩu.
- Vòng 9: Làm rõ email tuần, đổi tài liệu, bảo vệ mật khẩu → email gửi ngay sau buổi thứ 5, duyệt trong app; không cho đổi tài liệu giữa buổi; không khóa khi sai mật khẩu.
- Bổ sung sau phỏng vấn: ngân sách ưu tiên miễn phí vì là app cá nhân.
