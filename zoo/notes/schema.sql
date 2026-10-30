-- The notes app's tables. The app runs this at every start; so does the seed, before seed.sql.
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every save, and the revision the editor started from.
CREATE TABLE IF NOT EXISTS revisions (
  note_id INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  base_rev INTEGER NOT NULL,
  body TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Deleted notes.
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER NOT NULL,
  body TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
