PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS mirror_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  server_id TEXT NOT NULL, library_id TEXT NOT NULL, epoch TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, active_generation TEXT, published_at TEXT
);
INSERT OR IGNORE INTO mirror_library(singleton, server_id, library_id, epoch)
VALUES (1, lower(hex(randomblob(16))), lower(hex(randomblob(16))), lower(hex(randomblob(16))));
CREATE TABLE IF NOT EXISTS mirror_generations (
  id TEXT PRIMARY KEY, epoch TEXT NOT NULL, base_revision INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL, record_count INTEGER NOT NULL, content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mirror_chunks (
  generation_id TEXT NOT NULL REFERENCES mirror_generations(id) ON DELETE CASCADE,
  part INTEGER NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (generation_id, part)
);
