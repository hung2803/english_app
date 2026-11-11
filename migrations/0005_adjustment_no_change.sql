-- Đề xuất điều chỉnh tuần có thể "không cần đổi gì" (AI thấy kết quả tốt): lưu để vẫn có tóm tắt tuần,
-- nhưng không cần người học duyệt. Thêm trạng thái 'no_change' (SQLite không sửa được CHECK nên tạo lại bảng).
CREATE TABLE plan_adjustments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  week_no INTEGER NOT NULL,
  summary_vi TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','no_change')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  emailed_at TEXT,
  UNIQUE (plan_id, week_no)
);
INSERT INTO plan_adjustments_new (id, plan_id, week_no, summary_vi, changes_json, status, created_at, decided_at, emailed_at)
  SELECT id, plan_id, week_no, summary_vi, changes_json, status, created_at, decided_at, emailed_at FROM plan_adjustments;
DROP TABLE plan_adjustments;
ALTER TABLE plan_adjustments_new RENAME TO plan_adjustments;
CREATE INDEX idx_adjust_status ON plan_adjustments(status);
