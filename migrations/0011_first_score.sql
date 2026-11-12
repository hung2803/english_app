-- Làm lại bài tập tới 100% thì điểm hiển thị (score) thành 100; điểm của lần nộp đầu được giữ ở đây
-- để thống kê và để AI đánh giá tuần vẫn thấy chỗ người học còn yếu. NULL = chưa làm lại lần nào.
ALTER TABLE sessions ADD COLUMN first_score INTEGER;
