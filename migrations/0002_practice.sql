-- Luyện tập: chat với AI theo buổi, tài liệu người học tải lên.

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  corrections_json TEXT,                       -- lỗi AI sửa cho tin nhắn của người học
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_session ON chat_messages(session_id, id);

CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('file','link')),
  title TEXT NOT NULL,
  url TEXT,                                    -- kind = 'link'
  r2_key TEXT,                                 -- kind = 'file' (lưu ở R2)
  mime TEXT,
  size_bytes INTEGER,
  excerpt TEXT,                                -- đoạn trích ngắn đưa vào buổi học
  created_at TEXT NOT NULL,
  CHECK ((kind = 'link' AND url IS NOT NULL) OR (kind = 'file' AND r2_key IS NOT NULL))
);
