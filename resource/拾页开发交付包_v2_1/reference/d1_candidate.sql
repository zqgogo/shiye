-- 仅可选v1b的P0候选，未在真实D1验证；SQLite本地验证不代表D1发布通过。
-- 不含认证和业务校验。正式系统所有write都必须有epoch与CAS条件。
CREATE TABLE sync_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  db_epoch TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sync_meta(singleton,db_epoch,seq) VALUES(1,'P0-REPLACE-WITH-RANDOM-EPOCH',0);
CREATE TABLE sync_entities (
  entity_type TEXT NOT NULL CHECK(entity_type IN ('bookmark','readingItem','category','tag','policy')),
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  change_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  body_json TEXT,
  canonical_url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(entity_type,id)
);
CREATE INDEX idx_sync_changes ON sync_entities(change_version);
CREATE INDEX idx_sync_url ON sync_entities(canonical_url);
CREATE TRIGGER entity_insert_version AFTER INSERT ON sync_entities BEGIN
  UPDATE sync_meta SET seq=seq+1 WHERE singleton=1;
  UPDATE sync_entities SET change_version=(SELECT seq FROM sync_meta WHERE singleton=1)
    WHERE entity_type=NEW.entity_type AND id=NEW.id;
END;
CREATE TRIGGER entity_update_version AFTER UPDATE OF revision ON sync_entities
WHEN NEW.revision <> OLD.revision BEGIN
  UPDATE sync_meta SET seq=seq+1 WHERE singleton=1;
  UPDATE sync_entities SET change_version=(SELECT seq FROM sync_meta WHERE singleton=1)
    WHERE entity_type=NEW.entity_type AND id=NEW.id;
END;
-- INSERT候选（使用prepared statement绑定，不拼接用户内容）：
-- INSERT INTO sync_entities(entity_type,id,revision,body_json,canonical_url,updated_at)
-- SELECT ?,?,1,?,?,? FROM sync_meta WHERE singleton=1 AND db_epoch=?
-- ON CONFLICT(entity_type,id) DO NOTHING RETURNING id,revision;
-- UPDATE候选：
-- UPDATE sync_entities SET body_json=?,canonical_url=?,revision=revision+1,updated_at=?
-- WHERE entity_type=? AND id=? AND revision=? AND deleted_at IS NULL
-- AND EXISTS(SELECT 1 FROM sync_meta WHERE singleton=1 AND db_epoch=?)
-- RETURNING id,revision;
-- 同batch后续SELECT读取触发器后的change_version；RETURNING零行不是成功。
-- DELETE/RESTORE同理使用预期revision与epoch，显式控制deleted_at。
-- 普通CAS失败可服务端有限重读；不能自动重放客户端结果不确定的旧写入。
