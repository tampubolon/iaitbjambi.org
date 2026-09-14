/**
 * Ticket lookup and check-in, against Supabase.
 *
 * Reached over PostgREST rather than a Postgres connection: the direct host is
 * IPv6-only and the shared pooler does not carry this tenant, while Workers
 * egress is IPv4 and has no connection pool to speak of. HTTPS is the link
 * that actually exists between the two.
 *
 * The invariant this file exists to hold is PRD s12 — two phones confirming
 * the same ticket at the same moment produce exactly one attendance, and a
 * retry after a lost response does not produce a second. That is not enforced
 * here. It lives in the `do_check_in` function in supabase/schema.sql, so the
 * admissibility check and the write cannot be separated by a scheduler, a
 * retry, or a second Worker isolate.
 *
 * Every call carries the service_role key, which bypasses RLS. The tables have
 * RLS on with no policies and no grants to anon, so this Worker is the only
 * thing that can read participant data (PRD s10).
 */
import { normalise } from "./code";
import type { Env, Ticket } from "./model";

/** Raised when Supabase itself is unreachable or rejects the request. */
export class StoreError extends Error {}

async function rest(env: Env, path: string, init: RequestInit = {}): Promise<unknown> {
  const key = env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !key) throw new StoreError("supabase not configured");

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });

  const text = await response.text();
  if (!response.ok) {
    // Keep the body. At the door, "which ticket" and "why" is the difference
    // between waving someone through and sending them to the help desk.
    throw new StoreError(`supabase ${response.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * SHA-256, hex.
 *
 * The database stores only this. A token arrives from a QR or a URL, is hashed,
 * and the hash is what gets looked up, so the tickets table is not a list of
 * working tickets if it ever leaks.
 */
export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Tokens are Crockford base32; anything else is not worth a round trip. */
export function looksLikeToken(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/**
 * Normalises what a volunteer typed.
 *
 * Deliberately the builder's normalise(), not a second one: the same code now
 * admits a participant at the door and unlocks the builder, so someone who
 * types O for 0 must get the same answer in both places.
 */
export function normaliseCode(code: string): string {
  return normalise(code);
}

interface Attendance {
  checked_at: string;
  staff: string;
}

/**
 * check_ins.ticket_id is both the primary key and the foreign key, so
 * PostgREST reads the relationship as one-to-one and embeds a bare OBJECT,
 * not the array a to-many embed would give. Both shapes are accepted here
 * because that detection depends on the constraints PostgREST can see, and a
 * silent shape change would read as "nobody has checked in" — which is the
 * failure it already caused once.
 */
interface Row {
  ticket_id: string;
  name: string;
  wa_number: string;
  manual_code: string;
  builder_code: string | null;
  status: "active" | "revoked";
  check_ins: Attendance | Attendance[] | null;
}

/** Normalises either embed shape to the single attendance, or none. */
export function firstAttendance(embed: Attendance | Attendance[] | null | undefined) {
  if (!embed) return null;
  return Array.isArray(embed) ? (embed[0] ?? null) : embed;
}

const SELECT =
  "select=ticket_id,name,wa_number,manual_code,builder_code,status,check_ins(checked_at,staff)";

function toTicket(rows: unknown): Ticket | null {
  const row = Array.isArray(rows) ? (rows[0] as Row | undefined) : undefined;
  if (!row) return null;
  const seen = firstAttendance(row.check_ins);
  return {
    ticket_id: row.ticket_id,
    name: row.name,
    wa_number: row.wa_number,
    manual_code: row.manual_code,
    builder_code: row.builder_code,
    status: row.status,
    checked_at: seen?.checked_at ?? null,
    checked_by: seen?.staff ?? null,
  };
}

export async function byToken(env: Env, token: string): Promise<Ticket | null> {
  const hash = await hashToken(token);
  return toTicket(await rest(env, `tickets?token_hash=eq.${hash}&${SELECT}&limit=1`));
}

export async function byManualCode(env: Env, code: string): Promise<Ticket | null> {
  const clean = normaliseCode(code);
  if (!clean) return null;
  return toTicket(await rest(env, `tickets?manual_code=eq.${clean}&${SELECT}&limit=1`));
}

export interface CheckInResult {
  /** False when this ticket was already present — a duplicate, not a failure. */
  first: boolean;
  at: string;
  by: string;
}

/**
 * Records attendance, at most once, ever.
 *
 * Delegates to `do_check_in`, which decides admissibility and writes in one
 * statement and returns the winning row either way — so two phones racing show
 * the same time and the same staff name rather than disagreeing about who
 * admitted whom.
 *
 * @throws StoreError when the ticket does not exist or is revoked; the
 * function raises `check_violation` and PostgREST surfaces it as a 400.
 */
export async function checkIn(env: Env, ticketId: string, staff: string): Promise<CheckInResult> {
  const rows = (await rest(env, "rpc/do_check_in", {
    method: "POST",
    body: JSON.stringify({ p_ticket_id: ticketId, p_staff: staff }),
  })) as { first: boolean; at: string; by: string }[] | null;

  const row = rows?.[0];
  if (!row) throw new StoreError("check-in returned no row");
  return row;
}

export interface Counts {
  invited: number;
  attended: number;
  revoked: number;
}

/** Dashboard figures (PRD F06). One round trip; the door is busy. */
export async function counts(env: Env): Promise<Counts> {
  const rows = (await rest(env, "rpc/ticket_counts", { method: "POST", body: "{}" })) as
    | Counts[]
    | null;
  return rows?.[0] ?? { invited: 0, attended: 0, revoked: 0 };
}

/**
 * Reports whether the holder of this builder code has been admitted at the
 * door, which is what gates access to the builder.
 *
 * Fails CLOSED. A code with no ticket, a revoked ticket, or no attendance row
 * is refused, and so is a Supabase outage — the caller lets StoreError
 * propagate rather than catching it into a yes. The alternative, opening the
 * builder whenever the check cannot be made, would mean the gate is absent
 * exactly when the system is least healthy. If Supabase is down nobody can be
 * checked in either, so the event is already stopped; this does not make it
 * worse.
 *
 * @throws StoreError when Supabase cannot be reached or rejects the query.
 */
export async function admitted(env: Env, builderCode: string): Promise<boolean> {
  const clean = normalise(builderCode);
  if (!clean) return false;
  const rows = (await rest(
    env,
    `tickets?builder_code=eq.${clean}&status=eq.active&select=ticket_id,check_ins(checked_at)`,
  )) as { check_ins: unknown }[] | null;

  const row = Array.isArray(rows) ? rows[0] : undefined;
  return Boolean(row && firstAttendance(row.check_ins as never));
}

// --- admin -------------------------------------------------------------

export interface Found extends Ticket {
  is_staff: boolean;
}

/**
 * Finds participants by name or code, for the help desk.
 *
 * Matches a code exactly or a name loosely, because the two questions asked at
 * a help desk are "here is my code" and "I think I am on the list".
 * Deliberately capped: this is a lookup, not a way to page the whole list out
 * of the building.
 */
export async function search(env: Env, query: string, limit = 25): Promise<Found[]> {
  const q = query.trim();
  if (!q) return [];
  const code = normalise(q);
  const like = encodeURIComponent(`*${q.replace(/[*,()]/g, "")}*`);
  const filter = `or=(manual_code.eq.${code},builder_code.eq.${code},name.ilike.${like})`;
  const rows = (await rest(
    env,
    `tickets?${filter}&select=ticket_id,name,wa_number,manual_code,builder_code,status,is_staff,` +
      `check_ins(checked_at,staff)&order=name.asc&limit=${limit}`,
  )) as (Row & { is_staff: boolean })[] | null;

  return (rows ?? []).map((row) => {
    const seen = firstAttendance(row.check_ins);
    return {
      ticket_id: row.ticket_id,
      name: row.name,
      wa_number: row.wa_number,
      manual_code: row.manual_code,
      builder_code: row.builder_code,
      status: row.status,
      is_staff: row.is_staff,
      checked_at: seen?.checked_at ?? null,
      checked_by: seen?.staff ?? null,
    };
  });
}

/** Revokes or restores a ticket. The reason is recorded, not optional. */
export async function setStatus(
  env: Env,
  ticketId: string,
  status: "active" | "revoked",
  actor: string,
  reason: string,
): Promise<void> {
  await rest(env, "rpc/admin_set_status", {
    method: "POST",
    body: JSON.stringify({
      p_ticket_id: ticketId,
      p_status: status,
      p_actor: actor,
      p_reason: reason,
    }),
  });
}

/** Removes an attendance record — the PRD's "koreksi check-in" (F10). */
export async function undoCheckIn(
  env: Env,
  ticketId: string,
  actor: string,
  reason: string,
): Promise<void> {
  await rest(env, "rpc/admin_undo_check_in", {
    method: "POST",
    body: JSON.stringify({ p_ticket_id: ticketId, p_actor: actor, p_reason: reason }),
  });
}

/** Marks a participant present by hand, with a reason, audited (PRD F10). */
export async function adminAdmit(
  env: Env,
  ticketId: string,
  actor: string,
  reason: string,
): Promise<void> {
  await rest(env, "rpc/admin_admit", {
    method: "POST",
    body: JSON.stringify({ p_ticket_id: ticketId, p_actor: actor, p_reason: reason }),
  });
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  reason: string;
  detail: string | null;
}

/** Recent admin actions, newest first. */
export async function audit(env: Env, limit = 50): Promise<AuditEntry[]> {
  return ((await rest(
    env,
    `audit_logs?select=at,actor,action,reason,detail&order=at.desc&limit=${limit}`,
  )) ?? []) as AuditEntry[];
}

/** Every ticket, for the attendance export (F09). */
export async function all(env: Env): Promise<Found[]> {
  const rows = (await rest(
    env,
    `tickets?is_staff=is.false&select=ticket_id,name,wa_number,manual_code,builder_code,status,` +
      `is_staff,check_ins(checked_at,staff)&order=name.asc&limit=1000`,
  )) as (Row & { is_staff: boolean })[] | null;
  return (rows ?? []).map((row) => {
    const seen = firstAttendance(row.check_ins);
    return {
      ticket_id: row.ticket_id,
      name: row.name,
      wa_number: row.wa_number,
      manual_code: row.manual_code,
      builder_code: row.builder_code,
      status: row.status,
      is_staff: row.is_staff,
      checked_at: seen?.checked_at ?? null,
      checked_by: seen?.staff ?? null,
    };
  });
}
