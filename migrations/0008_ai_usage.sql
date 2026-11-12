-- Mỗi lần gọi Gemini ghi một dòng, để hiển thị RPM / TPM / RPD và token đã dùng ở trang chủ.
CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- thời điểm gọi (mili giây, UTC)
  day TEXT NOT NULL,              -- ngày theo giờ Thái Bình Dương (Google reset hạn mức ngày lúc 00:00 PT)
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1   -- 1 = thành công, 0 = Google từ chối/lỗi
);
CREATE INDEX idx_ai_usage_model_ts ON ai_usage (model, ts);
CREATE INDEX idx_ai_usage_model_day ON ai_usage (model, day);
