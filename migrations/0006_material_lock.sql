-- Khóa tài liệu của buổi học: sau khi đã chọn (chosen không còn NULL) thì material_json không được đổi nữa
-- (cả lựa chọn lẫn danh sách). Chốt cuối ở tầng CSDL, phòng khi code ở đâu đó vô tình ghi đè.
CREATE TRIGGER sessions_material_locked
BEFORE UPDATE OF material_json ON sessions
WHEN OLD.material_json IS NOT NULL
 AND json_extract(OLD.material_json, '$.chosen') IS NOT NULL
 AND NEW.material_json IS NOT OLD.material_json
BEGIN
  SELECT RAISE(ABORT, 'material_locked');
END;
