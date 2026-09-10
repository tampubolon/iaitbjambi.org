#!/usr/bin/env node
/**
 * Asserts wrangler.toml parses into the structure we intend.
 *
 * This exists because TOML folds a bare key into whichever [table] precedes
 * it, and that has silently broken this config twice:
 *
 *   1. `workers_dev = true` sat below [[queues.consumers]] and became part of
 *      it, so it was never a top-level setting.
 *   2. A regex edit removed the `[[queues.consumers]]` header for the main
 *      queue, and its settings — including max_concurrency — folded into
 *      [[queues.producers]]. The consumer stayed attached from an earlier
 *      deploy, so nothing failed; it just kept running the previous
 *      concurrency while the file claimed otherwise.
 *
 * Neither showed up in tests, a typecheck, or a successful deploy. Both would
 * have surfaced here.
 */
import { readFileSync } from "node:fs";
import { parseTOML } from "confbox";

const cfg = parseTOML(readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8"));
const problems = [];
const need = (cond, msg) => cond || problems.push(msg);

// Top-level keys — the ones most easily swallowed by a preceding table.
need(cfg.name === "aimpact", `name should be "aimpact", got ${JSON.stringify(cfg.name)}`);
need(cfg.workers_dev === true, "workers_dev must be top level and true (fallback URL)");
need(typeof cfg.account_id === "string", "account_id missing at top level");
need(typeof cfg.compatibility_date === "string", "compatibility_date missing at top level");

// Assets: without run_worker_first, static files are served before the Worker
// runs, so every hostname returns the builder UI instead of a participant page.
need(cfg.assets?.run_worker_first === true, "assets.run_worker_first must be true");

// Queues: a producer carrying consumer settings means a header was lost.
const producers = cfg.queues?.producers ?? [];
const consumers = cfg.queues?.consumers ?? [];
need(producers.length === 1, `expected 1 producer, got ${producers.length}`);
for (const p of producers) {
  for (const k of ["max_concurrency", "max_retries", "dead_letter_queue", "max_batch_size"]) {
    need(!(k in p), `producer has consumer key "${k}" — a [[queues.consumers]] header was lost`);
  }
}

const main = consumers.find((c) => c.queue === "aimpact-generate");
const dlq = consumers.find((c) => c.queue === "aimpact-generate-dlq");
need(main, "no consumer declared for aimpact-generate");
need(dlq, "no consumer declared for aimpact-generate-dlq — failures would vanish silently");

if (main) {
  // Measured ceiling: 80,000 output tok/min / ~1,939 per page / (60/16s) per
  // slot. Above ~11 the queue outruns the rate limit and returns 429s.
  need(
    main.max_concurrency >= 1 && main.max_concurrency <= 11,
    `main consumer max_concurrency ${main.max_concurrency} outside 1..11 — re-run measure.py`,
  );
  need(main.dead_letter_queue === "aimpact-generate-dlq", "main consumer has no dead_letter_queue");
}
if (dlq) {
  need(dlq.max_retries === 0, "dlq consumer must not retry — that is how the message got there");
}

if (problems.length) {
  console.error("wrangler.toml problems:");
  for (const p of problems) console.error("  -", p);
  process.exit(1);
}
console.log(
  `wrangler.toml ok — main consumer concurrency ${main.max_concurrency}, ` +
    `dlq consumed, run_worker_first on, workers_dev on`,
);
