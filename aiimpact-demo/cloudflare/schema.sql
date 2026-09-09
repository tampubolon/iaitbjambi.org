-- D1 (SQLite). Replaces the two DynamoDB tables in the AWS variant.
--
-- SQLite gives us something DynamoDB could not: the generation cap and the
-- slug claim are ordinary constraints and conditional UPDATEs, checked by the
-- engine rather than assembled from condition expressions.

CREATE TABLE IF NOT EXISTS participants (
  code             TEXT PRIMARY KEY,
  slug             TEXT UNIQUE,              -- NULL until first publish; unique thereafter
  business_name    TEXT,
  wa_number        TEXT,
  generation_count INTEGER NOT NULL DEFAULT 0,
  redeemed_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- UNIQUE on slug is the real guarantee. Unlike the eventually-consistent GSI
-- it replaces, a duplicate insert fails immediately and deterministically.
CREATE INDEX IF NOT EXISTS participants_slug ON participants (slug);

CREATE TABLE IF NOT EXISTS jobs (
  job_id     TEXT PRIMARY KEY,
  code       TEXT NOT NULL REFERENCES participants (code),
  slug       TEXT,
  status     TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'error')),
  url        TEXT,
  message    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS jobs_code ON jobs (code, created_at DESC);
