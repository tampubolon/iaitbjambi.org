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
}

export interface QueueMessage {
  job_id: string;
  code: string;
  prompt: string;
}
