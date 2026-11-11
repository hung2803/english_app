-- Điểm từng mức của mỗi lần test (để xét "đạt 100% các mức") và theo dõi lần test đã dùng để xét lộ trình.
ALTER TABLE placement_results ADD COLUMN per_level_json TEXT;   -- {"A0":{"right":4,"total":4},...}
ALTER TABLE plans ADD COLUMN checked_placement_id INTEGER REFERENCES placement_results(id); -- lần test gần nhất đã được xét (chưa đạt → thêm tuần ôn)
