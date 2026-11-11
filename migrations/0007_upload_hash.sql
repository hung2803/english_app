-- Chống tải trùng: cùng nội dung file (SHA-256) chỉ lưu một lần.
ALTER TABLE uploads ADD COLUMN sha256 TEXT;
CREATE UNIQUE INDEX idx_uploads_sha ON uploads(sha256) WHERE sha256 IS NOT NULL;
