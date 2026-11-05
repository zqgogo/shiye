CREATE TABLE IF NOT EXISTS capture_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  server_id TEXT NOT NULL, library_id TEXT NOT NULL, epoch TEXT NOT NULL,
  device_id TEXT NOT NULL, device_hash TEXT NOT NULL, input_hash TEXT NOT NULL,
  payload TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','received','rejected','cancelled')),
  receipt TEXT, created_at TEXT NOT NULL, settled_at TEXT
);
CREATE INDEX IF NOT EXISTS capture_inbox_status_seq ON capture_inbox(status,seq);
CREATE INDEX IF NOT EXISTS capture_inbox_device ON capture_inbox(device_id,device_hash,seq);
