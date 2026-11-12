-- Bài tập (quiz) của buổi trước phải đạt 100% mới mở buổi kế tiếp.
-- quiz_mastered: NULL = không yêu cầu (buổi cũ hoặc chưa nộp), 0 = nộp lần đầu chưa đủ 100% (phải làm lại câu sai), 1 = đã đạt 100%.
-- Điểm gốc (score, result_json) của lần nộp đầu giữ nguyên để thống kê; việc làm lại không đổi điểm.
-- quiz_retry_json: { "remaining": [chỉ số câu còn sai], "round": số lượt đã nộp }.
ALTER TABLE sessions ADD COLUMN quiz_mastered INTEGER;
ALTER TABLE sessions ADD COLUMN quiz_retry_json TEXT;
