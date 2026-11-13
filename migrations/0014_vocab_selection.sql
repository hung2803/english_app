-- Existing cards keep their schedule; newly composed lesson words start unselected.
ALTER TABLE vocab ADD COLUMN learning_state TEXT NOT NULL DEFAULT 'active'
  CHECK (learning_state IN ('available', 'queued', 'active'));
ALTER TABLE vocab ADD COLUMN selected_at TEXT;
ALTER TABLE vocab ADD COLUMN activated_on TEXT;
ALTER TABLE vocab ADD COLUMN mastery_started_on TEXT;
ALTER TABLE vocab ADD COLUMN last_success_on TEXT;
-- Old same-day counts cannot establish recall on separate days.
UPDATE vocab SET typed_streak = 0 WHERE learned = 0;
CREATE INDEX idx_vocab_queue ON vocab(learning_state, selected_at, id);
