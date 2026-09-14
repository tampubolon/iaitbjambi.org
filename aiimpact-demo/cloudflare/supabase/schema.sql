-- Ticketing schema, Supabase Postgres.
--
-- Ported from the D1/SQLite version in ../schema.sql. The shape is the same;
-- what changes is that Postgres gives us real timestamps, a real enum-ish
-- domain via CHECK, and row-level security — which matters here because
-- PostgREST exposes every table over HTTPS by default.

-- === tickets ===========================================================
--
-- The PRD's central security point (s6): the QR shown at the door and the
-- credential that unlocks the builder must be two different secrets, because
-- a ticket photo can be copied or read over a shoulder. builder_code links
-- the two without either standing in for the other.

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id    text PRIMARY KEY,
  name         text NOT NULL,
  wa_number    text NOT NULL,
  -- Only the hash. The plaintext token lives in the QR and in the one-time
  -- distribution export; the server never needs it back, so a leaked database
  -- does not yield working tickets.
  token_hash   text NOT NULL UNIQUE,
  manual_code  text NOT NULL UNIQUE,
  builder_code text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tickets_manual ON tickets (manual_code);
CREATE INDEX IF NOT EXISTS tickets_token ON tickets (token_hash);

-- === check_ins =========================================================
--
-- One attendance per ticket, enforced by the engine rather than by the
-- application remembering to check. ticket_id is the PRIMARY KEY, so "two
-- phones confirm the same ticket at the same instant" resolves to one INSERT
-- winning and the other conflicting — which is also what makes a retry after
-- a lost response idempotent rather than a second attendance (PRD s12).

CREATE TABLE IF NOT EXISTS check_ins (
  ticket_id  text PRIMARY KEY REFERENCES tickets (ticket_id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  staff      text NOT NULL
);

-- === check-in, as one atomic statement =================================
--
-- A function rather than application code, so the admissibility check and the
-- write cannot be separated by a scheduler. Returns which of the two things
-- happened and, either way, the winning row — so two phones racing show the
-- same name and the same time instead of disagreeing about who admitted whom.
--
-- SECURITY DEFINER with a pinned search_path: callers need no direct write
-- grant on check_ins, and the function cannot be hijacked by a caller-supplied
-- search_path.

CREATE OR REPLACE FUNCTION do_check_in(p_ticket_id text, p_staff text)
RETURNS TABLE (first boolean, at timestamptz, by text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted check_ins%ROWTYPE;
  v_existing check_ins%ROWTYPE;
BEGIN
  INSERT INTO check_ins (ticket_id, staff)
  SELECT p_ticket_id, p_staff
    FROM tickets t
   WHERE t.ticket_id = p_ticket_id AND t.status = 'active'
  ON CONFLICT (ticket_id) DO NOTHING
  RETURNING * INTO v_inserted;

  IF FOUND THEN
    RETURN QUERY SELECT true, v_inserted.checked_at, v_inserted.staff;
    RETURN;
  END IF;

  SELECT * INTO v_existing FROM check_ins c WHERE c.ticket_id = p_ticket_id;
  IF FOUND THEN
    RETURN QUERY SELECT false, v_existing.checked_at, v_existing.staff;
    RETURN;
  END IF;

  -- No insert and no existing row: the ticket is missing or revoked.
  RAISE EXCEPTION 'ticket not active' USING ERRCODE = 'check_violation';
END;
$$;

-- === row-level security ================================================
--
-- PostgREST publishes these tables over HTTPS, and the anon key is public by
-- design — it ships to any browser. RLS is on with NO policies, so anon and
-- authenticated can read and write nothing at all.
--
-- The Worker holds the service_role key, which bypasses RLS. That is the
-- whole authorisation model here: participant data is never reachable from a
-- public endpoint (PRD s10), and the Worker is the only thing that can read it.

ALTER TABLE tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets  FORCE ROW LEVEL SECURITY;
ALTER TABLE check_ins FORCE ROW LEVEL SECURITY;

REVOKE ALL ON tickets, check_ins FROM anon, authenticated;
REVOKE ALL ON FUNCTION do_check_in(text, text) FROM anon, authenticated, public;

-- Dashboard figures in one round trip. The door is busy and the board
-- refreshes every fifteen seconds; three separate REST calls for three
-- numbers is three chances to be slow.
CREATE OR REPLACE FUNCTION ticket_counts()
RETURNS TABLE (invited bigint, attended bigint, revoked bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT (SELECT count(*) FROM tickets WHERE status = 'active'),
         (SELECT count(*) FROM check_ins),
         (SELECT count(*) FROM tickets WHERE status = 'revoked');
$$;

REVOKE ALL ON FUNCTION ticket_counts() FROM anon, authenticated, public;
