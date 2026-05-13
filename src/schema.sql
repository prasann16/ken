-- ken schema v2 — body + tags + timestamps. Display fields derived at format time.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '2');

CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  source      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_deleted_at ON memories(deleted_at);

CREATE TABLE IF NOT EXISTS embeddings (
  memory_id  TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, model),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  body,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (memory_id, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF body ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = new.id;
  INSERT INTO memories_fts (memory_id, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;
