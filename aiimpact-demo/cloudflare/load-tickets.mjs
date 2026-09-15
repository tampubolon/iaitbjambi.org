/**
 * Loads out/tickets.json into Supabase over PostgREST.
 *
 *   SUPABASE_SERVICE_KEY=$(cat ~/.sbkey) node load-tickets.mjs
 *
 * Over HTTPS rather than psql because the project's direct Postgres host is
 * IPv6-only and not reliably reachable; PostgREST is the path the Worker uses
 * anyway, so loading through it exercises the same door.
 *
 * Clears check_ins and tickets first: issuing a new list replaces the old one
 * outright, and a half-replaced ticket table is worse than either state.
 * Inserts in batches so one oversized request cannot fail the whole load.
 */
import { readFileSync } from "node:fs";

const URL_BASE = process.env.SUPABASE_URL ?? "https://lkjmymzxjnojbwvfpocm.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!KEY) {
  console.error("set SUPABASE_SERVICE_KEY (the service_role key, not anon)");
  process.exit(2);
}

const headers = {
  apikey: KEY,
  authorization: `Bearer ${KEY}`,
  "content-type": "application/json",
};

async function rest(path, init) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, { ...init, headers });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${path} ${body.slice(0, 300)}`);
  return body;
}

const rows = JSON.parse(readFileSync("out/tickets.json", "utf8"));
console.log(`  loading ${rows.length} tickets into ${URL_BASE}`);

// A filter is required for DELETE, so match everything explicitly.
await rest("check_ins?ticket_id=neq.__none__", { method: "DELETE" });
await rest("tickets?ticket_id=neq.__none__", { method: "DELETE" });
console.log("  cleared existing tickets and check-ins");

const BATCH = 50;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  await rest("tickets", { method: "POST", body: JSON.stringify(chunk) });
  console.log(`  inserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
}

const check = await rest("tickets?select=ticket_id&limit=1", {
  method: "GET",
  headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
});
console.log(`  done. sample row: ${check.slice(0, 80)}`);
