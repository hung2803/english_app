# Chọn từ và ôn tập

- Bài học giữ đầy đủ từ vựng để xem/nghe. Từ mới ở trạng thái `available`, chưa tự vào lịch ôn.
- Người học bấm thêm/bỏ chọn trong bài. Có tối đa 5 gợi ý; có thể chọn nhiều hơn 5 từ.
- Từ đã chọn ở trạng thái `queued`, được đưa vào lịch theo `selected_at`, rồi `id` để giữ thứ tự ổn định.
- Mặc định ôn 15 từ khác nhau/ngày, tối đa 5 từ mới. Dành chỗ cho từ cũ đến hạn trước; thiếu chỗ thì giảm hoặc dừng nhận từ mới.
- Từ sai có thể được thử lại trong ngày, không chiếm thêm suất của một từ khác. Ôn tự do là lựa chọn luyện thêm riêng, không nhận từ đang chờ học.
- “Đã thuộc” yêu cầu tự gõ/điền đúng, chọn Tốt/Dễ vào ít nhất 3 ngày khác nhau và cách lần nhớ đúng đầu ít nhất 7 ngày. Trắc nghiệm và ôn tự do không cộng ngày xác nhận đã thuộc. Chọn Khó không cộng ngày; Quên hoặc sai quiz đặt lại tiến độ nhớ.
- Mặc định “Ôn theo tiến độ”: từ mới làm trắc nghiệm chọn nghĩa trước. Chọn đúng ghi `recognized_on` và hiện “Nhận biết được”, rồi ở lượt ôn sau chuyển sang gõ/nghe. Có thể chọn riêng chế độ “Chọn đáp án” để tiếp tục luyện nhận biết. Trắc nghiệm luôn chấm tại máy chủ và không cộng ngày tự nhớ đúng.
- Từ cũ giữ lịch ôn và trạng thái đã thuộc khi nâng cấp. Chọn lại từ đã có không tạo trùng hoặc mất tiến độ. Bỏ chọn chỉ dừng lịch ôn, không xóa dữ liệu học.

Migration: `0014_vocab_selection.sql`, `0015_vocab_recognition.sql`. Chạy `npm run db:migrate:local` cho local. Khi triển khai production, áp dụng migration remote trước khi chạy Worker mới.

Giới hạn mặc định nằm trong `worker/flashcards.ts`: `DAILY_CAP`, `NEW_DAILY_CAP`, `STREAK_TO_LEARN`.
