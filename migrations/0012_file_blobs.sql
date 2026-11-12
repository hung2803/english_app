-- Lưu file người học tải lên ngay trong D1 khi không có R2 (xem worker/blob-store.ts).
-- File được cắt thành các đoạn base64 nhỏ vì D1 giới hạn ~2 MB cho mỗi giá trị trong một dòng.
CREATE TABLE file_blobs (
  key TEXT NOT NULL,            -- trùng uploads.r2_key
  part INTEGER NOT NULL,        -- thứ tự đoạn, từ 0
  data TEXT NOT NULL,           -- base64 của đoạn
  PRIMARY KEY (key, part)
);
