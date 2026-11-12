-- Ôn từ vựng bài trước (phải đạt 100%) trước khi bắt đầu buổi kế tiếp.
-- JSON: { "passed": bool, "remaining": ["từ chưa đúng", ...], "round": số lượt đã nộp }. NULL = chưa bắt đầu ôn.
ALTER TABLE sessions ADD COLUMN vocab_review_json TEXT;
