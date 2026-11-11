-- Điều chỉnh lộ trình cuối tuần, cài đặt, thông báo.

CREATE TABLE plan_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  week_no INTEGER NOT NULL,                    -- tuần vừa học xong
  summary_vi TEXT NOT NULL,                    -- tổng kết tuần cho email + màn hình duyệt
  changes_json TEXT NOT NULL,                  -- [{week_no, topic, goal_vi}] các tuần sau sẽ đổi
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  emailed_at TEXT,
  UNIQUE (plan_id, week_no)                    -- mỗi tuần chỉ một đề xuất
);
CREATE INDEX idx_adjust_status ON plan_adjustments(status);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('reminder_enabled', '1'), ('reminder_time', '20:00');

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- chống gửi trùng: mỗi loại thông báo tối đa một lần mỗi ngày
CREATE TABLE notification_log (
  kind TEXT NOT NULL CHECK (kind IN ('push_reminder','weekly_email')),
  day TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (kind, day)
);
