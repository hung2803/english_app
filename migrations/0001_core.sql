-- Lõi học tập: test trình độ, lộ trình, buổi học, từ vựng.
-- Ngày luôn là chuỗi 'YYYY-MM-DD' theo giờ Việt Nam; thời điểm là 'YYYY-MM-DDTHH:MM:SSZ' (UTC).

CREATE TABLE placement_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('A0','A1','A2','B1')),
  taken_at TEXT NOT NULL                       -- ngày làm bài
);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('A0','A1','A2','B1')),
  placement_id INTEGER REFERENCES placement_results(id),
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL
);
-- chỉ một lộ trình đang chạy
CREATE UNIQUE INDEX idx_plans_one_active ON plans(status) WHERE status = 'active';

CREATE TABLE plan_weeks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  week_no INTEGER NOT NULL CHECK (week_no >= 1),            -- 12 tuần gốc + các tuần ôn tập thêm
  topic TEXT NOT NULL,
  goal_vi TEXT NOT NULL,
  UNIQUE (plan_id, week_no)
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  week_no INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),                    -- 60 buổi gốc + 10 buổi mỗi lần thêm tuần ôn
  scheduled_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','missed')),
  material_json TEXT,                          -- {options[], chosen, fallback}: chỉ link + đoạn trích ngắn
  lesson_json TEXT,                            -- phần AI soạn: tóm tắt, giải thích, từ vựng, ngữ pháp, quiz
  result_json TEXT,                            -- kết quả chấm quiz
  score INTEGER CHECK (score BETWEEN 0 AND 100),
  completed_date TEXT,
  UNIQUE (plan_id, seq)
);
CREATE INDEX idx_sessions_plan_status ON sessions(plan_id, status, seq);
CREATE INDEX idx_sessions_completed ON sessions(completed_date);

CREATE TABLE vocab (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  pos TEXT,
  meaning TEXT NOT NULL,
  example TEXT,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  due_date TEXT NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  learned INTEGER NOT NULL DEFAULT 0 CHECK (learned IN (0,1)),
  wrong_count INTEGER NOT NULL DEFAULT 0,      -- số lần sai ở quiz, AI dùng khi điều chỉnh tuần
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_vocab_word ON vocab(lower(word));
CREATE INDEX idx_vocab_due ON vocab(due_date);
