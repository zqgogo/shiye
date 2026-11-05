CREATE TABLE IF NOT EXISTS shared_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0, operation_id TEXT);
INSERT OR IGNORE INTO shared_state(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS shared_entities(key TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT, public_body TEXT, bytes INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS shared_entities_version ON shared_entities(version,key);
CREATE TABLE IF NOT EXISTS shared_operations(id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, revision INTEGER NOT NULL, device_id TEXT NOT NULL, created_at TEXT NOT NULL);
