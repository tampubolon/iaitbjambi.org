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

-- Panitia tickets: the reserve codes prewarm.py uses to spin the builder's
-- queue up before the room arrives. They are real tickets so the admission
-- gate lets them through, pre-admitted so nobody has to scan them, and
-- flagged so they do not inflate the attendance the board reports.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_staff boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION ticket_counts()
RETURNS TABLE (invited bigint, attended bigint, revoked bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT (SELECT count(*) FROM tickets WHERE status = 'active' AND NOT is_staff),
         (SELECT count(*) FROM check_ins c JOIN tickets t USING (ticket_id)
           WHERE NOT t.is_staff),
         (SELECT count(*) FROM tickets WHERE status = 'revoked' AND NOT is_staff);
$$;
REVOKE ALL ON FUNCTION ticket_counts() FROM anon, authenticated, public;
-- Admin actions leave a trail. PRD F10 requires a reason and an audit record
-- for any check-in correction; this covers every admin write, not only those,
-- because "who un-admitted this person and why" is the question that gets
-- asked after the event, when nobody remembers.
CREATE TABLE IF NOT EXISTS audit_logs (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,
  action    text NOT NULL,
  ticket_id text,
  reason    text NOT NULL,
  detail    text
);

CREATE INDEX IF NOT EXISTS audit_at ON audit_logs (at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON audit_logs FROM anon, authenticated;
REVOKE ALL ON SEQUENCE audit_logs_id_seq FROM anon, authenticated;

-- Each admin write is one statement that both acts and records, so an action
-- can never be applied without its audit row, or recorded without happening.
CREATE OR REPLACE FUNCTION admin_set_status(
  p_ticket_id text, p_status text, p_actor text, p_reason text)
RETURNS TABLE (ticket_id text, name text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_row tickets%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE tickets t SET status = p_status WHERE t.ticket_id = p_ticket_id RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ticket not found' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO audit_logs (actor, action, ticket_id, reason, detail)
  VALUES (p_actor, 'status:' || p_status, p_ticket_id, p_reason, v_row.name);
  RETURN QUERY SELECT v_row.ticket_id, v_row.name, p_status;
END; $$;

-- Undo a check-in. The PRD calls this a correction and insists on a reason
-- (F10): someone scanned the wrong person, or a duplicate name was admitted.
CREATE OR REPLACE FUNCTION admin_undo_check_in(
  p_ticket_id text, p_actor text, p_reason text)
RETURNS TABLE (ticket_id text, removed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_gone integer;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM check_ins c WHERE c.ticket_id = p_ticket_id;
  GET DIAGNOSTICS v_gone = ROW_COUNT;
  INSERT INTO audit_logs (actor, action, ticket_id, reason, detail)
  VALUES (p_actor, 'undo_check_in', p_ticket_id, p_reason,
          CASE WHEN v_gone > 0 THEN 'removed' ELSE 'was not checked in' END);
  RETURN QUERY SELECT p_ticket_id, v_gone > 0;
END; $$;

REVOKE ALL ON FUNCTION admin_set_status(text, text, text, text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION admin_undo_check_in(text, text, text) FROM anon, authenticated, public;
-- "by" is reserved, so the column do_check_in returns under that name cannot
-- be read back as v_res.by — it has to be quoted. Aliasing into plain locals
-- keeps the rest of the body readable.
CREATE OR REPLACE FUNCTION admin_admit(p_ticket_id text, p_actor text, p_reason text)
RETURNS TABLE (first boolean, at timestamptz, by text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_first boolean;
  v_at    timestamptz;
  v_by    text;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'reason required' USING ERRCODE = 'check_violation';
  END IF;

  SELECT d.first, d.at, d."by" INTO v_first, v_at, v_by
    FROM do_check_in(p_ticket_id, p_actor || ' (admin)') d;

  INSERT INTO audit_logs (actor, action, ticket_id, reason, detail)
  VALUES (p_actor, 'admit', p_ticket_id, p_reason,
          CASE WHEN v_first THEN 'ditandai hadir' ELSE 'sudah hadir sebelumnya' END);

  RETURN QUERY SELECT v_first, v_at, v_by;
END; $$;
REVOKE ALL ON FUNCTION admin_admit(text, text, text) FROM anon, authenticated, public;
