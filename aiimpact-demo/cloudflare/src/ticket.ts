/**
 * Ticket lookup and check-in.
 *
 * The invariant this file exists to hold is PRD s12: two phones confirming the
 * same ticket at the same moment must produce exactly one attendance, and a
 * retry after a lost response must not produce a second. Both fall out of
 * `check_ins.ticket_id` being a PRIMARY KEY — the engine decides, not a
 * read-then-write in application code that can interleave.
 */
import type { Ticket, TicketRow } from "./model";

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

/** Tokens are Crockford base32; anything else is not worth a database round trip. */
export function looksLikeToken(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

const COLUMNS = `t.ticket_id, t.name, t.wa_number, t.manual_code, t.builder_code,
                 t.status, c.checked_at, c.staff AS checked_by`;

function toTicket(row: TicketRow | null): Ticket | null {
  if (!row) return null;
  return {
    ticket_id: row.ticket_id,
    name: row.name,
    wa_number: row.wa_number,
    manual_code: row.manual_code,
    builder_code: row.builder_code,
    status: row.status,
    checked_at: row.checked_at ?? null,
    checked_by: row.checked_by ?? null,
  };
}

export async function byToken(db: D1Database, token: string): Promise<Ticket | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM tickets t
       LEFT JOIN check_ins c ON c.ticket_id = t.ticket_id
       WHERE t.token_hash = ?`,
    )
    .bind(await hashToken(token))
    .first<TicketRow>();
  return toTicket(row);
}

export async function byManualCode(db: D1Database, code: string): Promise<Ticket | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM tickets t
       LEFT JOIN check_ins c ON c.ticket_id = t.ticket_id
       WHERE t.manual_code = ?`,
    )
    .bind(code.toUpperCase().replace(/[^0-9A-Z]/g, ""))
    .first<TicketRow>();
  return toTicket(row);
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
 * `ON CONFLICT DO NOTHING ... RETURNING` makes the outcome a single atomic
 * statement: a returned row means this call created the attendance, no row
 * means someone (or some earlier retry of this same call) got there first. The
 * caller then reads back the winning row, so both phones show the same time
 * and the same staff name rather than disagreeing about who admitted whom.
 *
 * @throws Error when the ticket does not exist or is revoked — checked here
 * rather than by the caller so there is no gap between the check and the write.
 */
export async function checkIn(
  db: D1Database,
  ticketId: string,
  staff: string,
): Promise<CheckInResult> {
  const inserted = await db
    .prepare(
      `INSERT INTO check_ins (ticket_id, staff)
       SELECT ?, ? FROM tickets WHERE ticket_id = ? AND status = 'active'
       ON CONFLICT (ticket_id) DO NOTHING
       RETURNING checked_at, staff`,
    )
    .bind(ticketId, staff, ticketId)
    .first<{ checked_at: string; staff: string }>();

  if (inserted) return { first: true, at: inserted.checked_at, by: inserted.staff };

  // No insert: either already checked in, or the ticket is not admissible.
  const existing = await db
    .prepare(`SELECT checked_at, staff FROM check_ins WHERE ticket_id = ?`)
    .bind(ticketId)
    .first<{ checked_at: string; staff: string }>();

  if (existing) return { first: false, at: existing.checked_at, by: existing.staff };
  throw new Error("ticket not active");
}

export interface Counts {
  invited: number;
  attended: number;
  revoked: number;
}

/** Dashboard figures (PRD F06). One query; the door is busy. */
export async function counts(db: D1Database): Promise<Counts> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tickets WHERE status = 'active')  AS invited,
         (SELECT COUNT(*) FROM check_ins)                        AS attended,
         (SELECT COUNT(*) FROM tickets WHERE status = 'revoked') AS revoked`,
    )
    .first<Counts>();
  return row ?? { invited: 0, attended: 0, revoked: 0 };
}
