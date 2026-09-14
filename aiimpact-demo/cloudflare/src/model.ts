/** Types shared between the API, the queue consumer and the renderer. */

export type JobStatus = "queued" | "running" | "done" | "error";

export interface Job {
  job_id: string;
  code: string;
  slug: string | null;
  status: JobStatus;
  url: string | null;
  message: string | null;
  created_at: string;
}

export interface Participant {
  code: string;
  slug: string | null;
  business_name: string | null;
  wa_number: string | null;
  generation_count: number;
  redeemed_at: string | null;
  created_at: string;
}

export interface Env {
  DB: D1Database;
  QUEUE: Queue<QueueMessage>;
  ASSETS: Fetcher;
  DOMAIN: string;
  MAX_GENERATIONS: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_API_KEY: string;
  SESSION_SECRET: string;
  /** Fallback provider. Absent means Anthropic only — see deepseek.ts. */
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  /** Shared password for the check-in staff pages. */
  STAFF_PASSWORD?: string;
  /** Supabase holds the ticketing tables; the builder still uses D1. */
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  EVENT_NAME?: string;
  EVENT_DATE?: string;
  EVENT_PLACE?: string;
}

/** A ticket joined to its attendance row, if any. */
export interface Ticket {
  ticket_id: string;
  name: string;
  wa_number: string;
  manual_code: string;
  builder_code: string | null;
  status: "active" | "revoked";
  checked_at: string | null;
  checked_by: string | null;
}

/** Raw shape of the tickets/check_ins join, before nulls are normalised. */
export interface TicketRow extends Omit<Ticket, "checked_at" | "checked_by"> {
  checked_at?: string | null;
  checked_by?: string | null;
}

export interface QueueMessage {
  job_id: string;
  code: string;
  prompt: string;
}
