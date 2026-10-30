-- The notes the app starts with (after schema.sql).
INSERT INTO notes (id, body, rev, updated_at) VALUES
  (1, 'Groceries' || char(10) || 'milk, eggs', 1, '2026-10-01 09:00:00'),
  (2, 'Trip to Lisbon' || char(10) || 'book the flights', 1, '2026-10-02 09:00:00'),
  (3, 'Ideas' || char(10) || 'a notes app that saves itself', 1, '2026-10-03 09:00:00');
INSERT INTO revisions (note_id, rev, base_rev, body, saved_at) SELECT id, 1, 0, body, updated_at FROM notes;
