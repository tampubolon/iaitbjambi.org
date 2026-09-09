/**
 * D1 access layer.
 *
 * Three operations carry correctness weight and are written as conditional
 * writes rather than read-then-write: claiming a slug, incrementing a
 * participant's generation count, and publishing. All three are contended --
 * 200 people submitting inside the same 30 seconds -- and a check-then-act
 * version of any of them would be wrong under exactly the load this system is
 * built for.
 *
 * D1 is a better fit than the DynamoDB it replaces: the cap becomes an
 * ordinary conditional UPDATE and slug uniqueness an ordinary UNIQUE index,
 * both checked by the engine rather than assembled from condition expressions,
 * with none of the eventual consistency the secondary index had.
 */
import type { Job, JobStatus, Participant } from "./model";

export class NotFound extends Error {}
export class CapReached extends Error {}
export class SlugTaken extends Error {}

function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err));
}

export class Store {
  constructor(private readonly db: D1Database) {}

  // --- participants --------------------------------------------------------

  async participant(code: string): Promise<Participant> {
    const row = await this.db
      .prepare("SELECT * FROM participants WHERE code = ?")
      .bind(code)
      .first<Participant>();
    if (!row) throw new NotFound(`no participant for code`);
    return row;
  }

  /**
   * Marks a code first used and returns the participant.
   *
   * Idempotent by design: a participant who reloads, loses signal mid-request,
   * or reopens the link must not be locked out of their own code with no
   * recovery short of finding a panitia member. Single use is enforced
   * socially -- one code per printed sheet -- not by refusing the second call.
   */
  async redeem(code: string): Promise<Participant> {
    const row = await this.db
      .prepare(
        `UPDATE participants
            SET redeemed_at = COALESCE(redeemed_at, datetime('now'))
          WHERE code = ?
      RETURNING *`,
      )
      .bind(code)
      .first<Participant>();
    if (!row) throw new NotFound(`no participant for code`);
    return row;
  }

  async slugFree(slug: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS taken FROM participants WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ taken: number }>();
    return row === null;
  }

  /**
   * Binds a slug to a participant, once.
   *
   * `slug IS NULL` makes the binding permanent, which is not cosmetic: a slug
   * is in someone's WhatsApp history the moment it is published, so it must
   * never move to another business. The UNIQUE index catches two participants
   * racing for the same name; the loser retries with the next suffix.
   */
  async claimSlug(code: string, slug: string): Promise<void> {
    let res: D1Result;
    try {
      res = await this.db
        .prepare("UPDATE participants SET slug = ? WHERE code = ? AND slug IS NULL")
        .bind(slug, code)
        .run();
    } catch (err) {
      if (isUniqueViolation(err)) throw new SlugTaken(slug);
      throw err;
    }
    if (res.meta.changes === 0) {
      // Either the code is unknown or a slug is already bound. A participant
      // regenerating already has one, which is the common case and not an error.
      const p = await this.participant(code);
      if (p.slug !== slug) throw new SlugTaken(slug);
    }
  }

  /**
   * Increments the generation count if, and only if, the participant is under
   * the cap, and returns the new count.
   *
   * One statement, not read-check-write. Under the burst this system is
   * designed for, a double tap would otherwise pass a check-then-act test
   * twice -- and this cap is what bounds worst-case spend.
   */
  async countGeneration(code: string, max: number): Promise<number> {
    const row = await this.db
      .prepare(
        `UPDATE participants
            SET generation_count = generation_count + 1
          WHERE code = ? AND generation_count < ?
      RETURNING generation_count`,
      )
      .bind(code, max)
      .first<{ generation_count: number }>();

    if (row) return row.generation_count;

    // No row updated: tell "unknown code" apart from "cap reached" so the
    // participant gets the right message.
    await this.participant(code); // throws NotFound if unknown
    throw new CapReached(code);
  }

  // --- jobs ----------------------------------------------------------------

  async createJob(jobId: string, code: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO jobs (job_id, code, status) VALUES (?, ?, 'queued')")
      .bind(jobId, code)
      .run();
  }

  async job(jobId: string): Promise<Job> {
    const row = await this.db
      .prepare("SELECT * FROM jobs WHERE job_id = ?")
      .bind(jobId)
      .first<Job>();
    if (!row) throw new NotFound(`no job ${jobId}`);
    return row;
  }

  async setJobStatus(
    jobId: string,
    status: JobStatus,
    opts: { url?: string; message?: string } = {},
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE jobs
            SET status  = ?,
                url     = COALESCE(?, url),
                message = COALESCE(?, message)
          WHERE job_id = ?`,
      )
      .bind(status, opts.url ?? null, opts.message ?? null, jobId)
      .run();
  }

  // --- pages ---------------------------------------------------------------

  /**
   * Writes the page and marks the job done in a single batch.
   *
   * This atomicity is the reason pages live in D1 rather than object storage:
   * a two-phase write can half-fail, leaving a job marked done with no page
   * behind it -- a participant shown a URL that 404s in front of a customer.
   */
  async publish(args: {
    slug: string;
    html: string;
    jobId: string;
    url: string;
  }): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO pages (slug, html, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT (slug) DO UPDATE SET html = excluded.html, updated_at = excluded.updated_at`,
        )
        .bind(args.slug, args.html),
      this.db
        .prepare("UPDATE jobs SET status = 'done', url = ?, slug = ? WHERE job_id = ?")
        .bind(args.url, args.slug, args.jobId),
    ]);
  }

  async page(slug: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT html FROM pages WHERE slug = ?")
      .bind(slug)
      .first<{ html: string }>();
    return row?.html ?? null;
  }
}
