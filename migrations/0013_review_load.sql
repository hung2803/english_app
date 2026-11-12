-- Giảm tải ôn từ vựng: trần số thẻ mỗi ngày, ưu tiên từ hay sai, "đã thuộc" khi viết đúng liên tiếp.
-- typed_streak: số lần liên tiếp ôn đúng (viết đúng từ và chọn Tốt/Dễ); về 0 khi Quên, viết sai hoặc sai quiz.
-- lapses: số lần bấm Quên / viết sai ở thẻ (độ "hay sai" để ưu tiên ôn).
-- reviewed_on: ngày ôn gần nhất (VN) — dùng đếm số thẻ đã ôn hôm nay.
ALTER TABLE vocab ADD COLUMN typed_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vocab ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vocab ADD COLUMN reviewed_on TEXT;
