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

-- Published pages.
--
-- These live in D1 rather than R2 because R2 requires dashboard activation and
-- a payment method even inside its free tier, and the objects here do not
-- justify it: 200 pages of roughly 8 KB is ~1.6 MB against D1's 5 GB. Serving
-- a page costs one indexed row read against a 5M/day allowance, and dropping
-- R2 removes a binding, a service to enable, and a failure mode.
CREATE TABLE IF NOT EXISTS pages (
  slug       TEXT PRIMARY KEY,
  html       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- === Ticketing (PRD "Tiket Event & Akses Pembuat Landing Page", s10) =========
--
-- Deliberately separate from `participants`. The PRD's central security point
-- (s6) is that the QR shown at the door and the credential that unlocks the
-- builder must be two different secrets, because a ticket photo can be copied
-- or read over a shoulder. `tickets.builder_code` links the two without
-- letting either stand in for the other.

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  wa_number    TEXT NOT NULL,              -- normalised: 62..., digits only
  -- Only the hash. The plaintext token lives in the QR and in the one-time
  -- distribution export; the server never needs it back, and a leaked database
  -- therefore does not yield working tickets. Re-issuing is an explicit admin
  -- act that revokes the old token (PRD s4.1).
  token_hash   TEXT NOT NULL UNIQUE,
  manual_code  TEXT NOT NULL UNIQUE,       -- readable fallback when the camera fails
  builder_code TEXT REFERENCES participants (code),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS tickets_manual ON tickets (manual_code);

-- One attendance per ticket, enforced by the engine rather than by the
-- application remembering to check.
--
-- ticket_id is the PRIMARY KEY, so "two phones confirm the same ticket at the
-- same instant" resolves to one INSERT winning and the other conflicting —
-- which is also what makes a retry after a lost response idempotent rather
-- than a second attendance (PRD s12).
CREATE TABLE IF NOT EXISTS check_ins (
  ticket_id  TEXT PRIMARY KEY REFERENCES tickets (ticket_id),
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  staff      TEXT NOT NULL
);
