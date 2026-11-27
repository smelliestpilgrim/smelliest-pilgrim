-- Smelliest Pilgrim server schema (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS memos (
  id      TEXT PRIMARY KEY,      -- watch memo id (epoch ms at start)
  day     TEXT NOT NULL,         -- YYYY-MM-DD, watch local time
  time    TEXT NOT NULL,         -- HH:MM:SS, watch local time
  file    TEXT NOT NULL,         -- HHMM-SS.ogg (same naming as the phone app)
  t       INTEGER NOT NULL,
  tz      INTEGER,               -- watch UTC offset, minutes
  size    INTEGER NOT NULL,      -- raw watch bytes
  crc     INTEGER NOT NULL,      -- CRC-32 of the raw watch bytes
  mode    TEXT NOT NULL,         -- 'o' byte-offset chunks or 'i' index chunks
  meta    TEXT NOT NULL,         -- JSON: the commit form (GPS, recMs, stopKey, note...)
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memos_day ON memos(day);

-- Chunks as the watch sent them. While a memo is pending they may include
-- stale resends; at commit only the verified path from byte 0 is kept.
CREATE TABLE IF NOT EXISTS chunks (
  memo_id TEXT NOT NULL,
  kind    TEXT NOT NULL,         -- 'o' (pos = byte offset) or 'i' (pos = index)
  pos     INTEGER NOT NULL,
  n       INTEGER NOT NULL,      -- 'i': chunk count; 'o': -1
  len     INTEGER NOT NULL,
  data    BLOB NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (memo_id, kind, pos)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS logparts (
  id   TEXT NOT NULL,
  i    INTEGER NOT NULL,
  n    INTEGER NOT NULL,
  data BLOB NOT NULL,
  at   INTEGER NOT NULL,
  PRIMARY KEY (id, i)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS logs (
  name    TEXT PRIMARY KEY,      -- watch-log-HHMMSS.txt
  day     TEXT NOT NULL,
  data    BLOB NOT NULL,
  created INTEGER NOT NULL
);
