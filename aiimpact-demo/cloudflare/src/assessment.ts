/**
 * Pre-test and post-test results.
 *
 * Stored as one row per participant per test in `settings`, keyed
 * "pre:<code>" / "post:<code>". That table is a key-value store and this uses
 * it as one: two participants submitting at the same moment write different
 * keys and cannot overwrite each other. A single JSON blob holding all 205
 * would be a read-modify-write race with two hundred writers, which loses
 * answers silently — the worst possible failure for something a participant
 * only does once.
 *
 * Deliberately no new tables: creating them needs DDL, the project's direct
 * Postgres host is unreachable from the deploy environment, and PostgREST
 * cannot run DDL. Waiting on a hand-run migration the night before the event
 * is a worse trade than an unorthodox key.
 *
 * Nothing here refuses anyone. The result is information for the staff at the
 * door, not a gate: check-in, the builder and the admin override all behave
 * exactly as they did before this existed.
 */
import { type Kind, score } from "./assessment-bank";
import type { Env } from "./model";

export interface Result {
  kind: Kind;
  score: number;
  at: string;
  answers: Record<string, string>;
}

function key(kind: Kind, code: string): string {
  return `${kind}:${code.toUpperCase()}`;
}

async function rest(env: Env, path: string, init: RequestInit = {}): Promise<unknown> {
  const svc = env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !svc) throw new Error("supabase not configured");
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: svc,
      authorization: `Bearer ${svc}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** One participant's result for one test, or null if they have not sat it. */
export async function get(env: Env, kind: Kind, code: string): Promise<Result | null> {
  try {
    const rows = (await rest(
      env,
      `settings?key=eq.${encodeURIComponent(key(kind, code))}&select=value`,
    )) as { value: string }[] | null;
    const raw = rows?.[0]?.value;
    return raw ? (JSON.parse(raw) as Result) : null;
  } catch {
    // A lookup failure must not break the page it decorates. The participant
    // sees an un-taken test and can sit it again; the desk sees "belum".
    return null;
  }
}

/**
 * Records a submission and returns the stored result.
 *
 * The first submission wins. A participant who loses signal after submitting
 * and retries gets their original score back rather than a second attempt —
 * otherwise the retry is a way to improve it, and the pre/post comparison
 * stops meaning anything.
 */
export async function submit(
  env: Env,
  kind: Kind,
  code: string,
  answers: Record<string, string>,
): Promise<Result> {
  const existing = await get(env, kind, code);
  if (existing) return existing;

  const result: Result = {
    kind,
    score: score(kind, answers),
    at: new Date().toISOString(),
    answers,
  };
  await rest(env, "settings", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      key: key(kind, code),
      value: JSON.stringify(result),
      updated_by: "peserta",
    }),
  });
  return result;
}

/**
 * Every result of one kind, keyed by participant code.
 *
 * One query for the whole room rather than 205, so the admin list and the
 * attendance board each cost a single round trip.
 */
export async function all(env: Env, kind: Kind): Promise<Map<string, Result>> {
  const out = new Map<string, Result>();
  try {
    const rows = (await rest(
      env,
      `settings?key=like.${kind}:*&select=key,value&limit=1000`,
    )) as { key: string; value: string }[] | null;
    for (const row of rows ?? []) {
      try {
        out.set(row.key.slice(kind.length + 1), JSON.parse(row.value) as Result);
      } catch {
        // One unreadable row should not cost the whole board.
      }
    }
  } catch {
    // Same reasoning as get(): degrade to "nobody has sat it" rather than 500.
  }
  return out;
}
