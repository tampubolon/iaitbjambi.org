/**
 * Event outcome figures for the organisers — tiket.<domain>/admin/statistik.
 *
 * Pure computation over rows the admin handler already knows how to fetch, so
 * the numbers can be tested without Supabase or D1. Everything counts
 * participants only: panitia accounts (settings.panitia_codes) and cancelled
 * tickets are left out, because a report of the event's output should not
 * include the people who ran it or the people who were replaced.
 */
import { bank, type Kind } from "./assessment-bank";
import type { Result } from "./assessment";

export interface TicketRow {
  code: string;
  status: string;
  /** ISO timestamp of check-in, or null. */
  checkedAt: string | null;
}

export interface LabRow {
  code: string;
  redeemed: boolean;
  generations: number;
  built: boolean;
}

export interface JobRow {
  code: string;
  status: string;
  /** D1 datetime('now'): "YYYY-MM-DD HH:MM:SS", UTC. */
  createdAt: string;
}

export interface StatsInput {
  tickets: TicketRow[];
  panitia: Set<string>;
  pre: Map<string, Result>;
  post: Map<string, Result>;
  lab: LabRow[];
  jobs: JobRow[];
  maxGenerations: number;
}

export interface Bucket {
  label: string;
  value: number;
}

export interface TestSummary {
  count: number;
  average: number;
  median: number;
  /** Score (0, 10 … 100) to number of participants. */
  distribution: Bucket[];
  /** Share of submissions answering each question correctly, 0–1. */
  questions: { id: string; text: string; correct: number }[];
}

export interface Stats {
  registered: number;
  attended: number;
  arrivals: Bucket[];
  funnel: Bucket[];
  pre: TestSummary;
  post: TestSummary;
  paired: {
    count: number;
    preAverage: number;
    postAverage: number;
    improved: number;
    same: number;
    declined: number;
  };
  postWithoutCheckIn: number;
  lab: {
    maxGenerations: number;
    signedIn: number;
    websites: number;
    prompts: number;
    failed: number;
    attendedWithoutWebsite: number;
    /** Slots used (0 … max) to number of participants. */
    slotsUsed: Bucket[];
    builds: Bucket[];
  };
}

const WIB_MS = 7 * 60 * 60 * 1000;

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** UTC instant to its WIB hour, as a sortable key and a label. */
function wibHour(ms: number): { key: string; day: string; hour: string } {
  const d = new Date(ms + WIB_MS);
  const iso = d.toISOString();
  return {
    key: iso.slice(0, 13),
    day: `${iso.slice(8, 10)}/${iso.slice(5, 7)}`,
    hour: `${iso.slice(11, 13)}.00`,
  };
}

/**
 * Counts instants per WIB hour, filling empty hours between the first and the
 * last so a quiet hour shows as a gap rather than disappearing. The date is
 * only added to the label when the instants span more than one day.
 */
export function perHour(instants: number[]): Bucket[] {
  const valid = instants.filter((n) => Number.isFinite(n));
  if (!valid.length) return [];
  const hour = 60 * 60 * 1000;
  const first = Math.floor(Math.min(...valid) / hour) * hour;
  const last = Math.floor(Math.max(...valid) / hour) * hour;
  // A stray timestamp days away would otherwise produce hundreds of empty bars.
  if ((last - first) / hour > 48) {
    const counts = new Map<string, { label: string; value: number }>();
    for (const n of valid) {
      const h = wibHour(n);
      const e = counts.get(h.key) ?? { label: `${h.day} ${h.hour}`, value: 0 };
      e.value += 1;
      counts.set(h.key, e);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  }
  const multiDay = wibHour(first).day !== wibHour(last).day;
  const out: Bucket[] = [];
  for (let t = first; t <= last; t += hour) {
    const h = wibHour(t);
    out.push({
      label: multiDay ? `${h.day} ${h.hour}` : h.hour,
      value: valid.filter((n) => n >= t && n < t + hour).length,
    });
  }
  return out;
}

function summarise(kind: Kind, results: Result[]): TestSummary {
  const scores = results.map((r) => r.score);
  const distribution: Bucket[] = [];
  for (let s = 0; s <= 100; s += 10) {
    distribution.push({ label: String(s), value: scores.filter((x) => x === s).length });
  }
  const questions = bank(kind).map((q) => ({
    id: q.id,
    text: q.q,
    correct: results.length
      ? results.filter((r) => r.answers?.[q.id] === q.a).length / results.length
      : 0,
  }));
  return {
    count: results.length,
    average: average(scores),
    median: median(scores),
    distribution,
    questions,
  };
}

function d1Instant(s: string): number {
  return Date.parse(`${s.replace(" ", "T")}Z`);
}

/** Computes every figure on the statistics page. */
export function compute(input: StatsInput): Stats {
  const people = input.tickets.filter(
    (t) => t.status === "active" && !input.panitia.has(t.code.toUpperCase()),
  );
  const codes = new Set(people.map((t) => t.code.toUpperCase()));
  const attended = people.filter((t) => t.checkedAt);
  const attendedCodes = new Set(attended.map((t) => t.code.toUpperCase()));

  const pick = (m: Map<string, Result>) =>
    new Map([...m].filter(([code]) => codes.has(code.toUpperCase())));
  const pre = pick(input.pre);
  const post = pick(input.post);

  const lab = input.lab.filter((r) => codes.has(r.code.toUpperCase()));
  const websites = lab.filter((r) => r.built);
  const builtCodes = new Set(websites.map((r) => r.code.toUpperCase()));
  const jobs = input.jobs.filter((j) => codes.has(j.code.toUpperCase()));

  const pairs = [...pre.keys()].filter((c) => post.has(c));
  const deltas = pairs.map((c) => post.get(c)!.score - pre.get(c)!.score);

  const slotsUsed: Bucket[] = [];
  const top = Math.max(0, ...lab.map((r) => r.generations));
  for (let n = 0; n <= Math.min(top, input.maxGenerations); n++) {
    slotsUsed.push({ label: String(n), value: lab.filter((r) => r.generations === n).length });
  }

  return {
    registered: people.length,
    attended: attended.length,
    arrivals: perHour(attended.map((t) => Date.parse(t.checkedAt!))),
    funnel: [
      { label: "Terdaftar", value: people.length },
      { label: "Mengerjakan pre-test", value: pre.size },
      { label: "Hadir (check-in)", value: attended.length },
      { label: "Masuk lab AIMPACT", value: lab.filter((r) => r.redeemed).length },
      { label: "Website jadi", value: websites.length },
      { label: "Mengerjakan post-test", value: post.size },
    ],
    pre: summarise("pre", [...pre.values()]),
    post: summarise("post", [...post.values()]),
    paired: {
      count: pairs.length,
      preAverage: average(pairs.map((c) => pre.get(c)!.score)),
      postAverage: average(pairs.map((c) => post.get(c)!.score)),
      improved: deltas.filter((d) => d > 0).length,
      same: deltas.filter((d) => d === 0).length,
      declined: deltas.filter((d) => d < 0).length,
    },
    postWithoutCheckIn: [...post.keys()].filter((c) => !attendedCodes.has(c.toUpperCase())).length,
    lab: {
      maxGenerations: input.maxGenerations,
      signedIn: lab.filter((r) => r.redeemed).length,
      websites: websites.length,
      prompts: lab.reduce((n, r) => n + r.generations, 0),
      failed: jobs.filter((j) => j.status === "error").length,
      attendedWithoutWebsite: [...attendedCodes].filter((c) => !builtCodes.has(c)).length,
      slotsUsed,
      builds: perHour(jobs.map((j) => d1Instant(j.createdAt))),
    },
  };
}
