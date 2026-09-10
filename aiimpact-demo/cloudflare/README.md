# Cloudflare Worker — AIMPACT demo

Implementation of [`../README.md`](../README.md) on Cloudflare's free plan.

**Live:** https://aimpact.iaitbjambi.org — builder UI, with participant pages at
`{slug}.iaitbjambi.org`. Fallback: `aimpact.tampubolonmartinus8.workers.dev`,
where `/p/{slug}` stands in for the wildcard subdomains workers.dev lacks.

This is the **active** target. [`../terraform/`](../terraform/) is the AWS variant —
complete and validated, retained because the design decisions in it still apply,
but not the deployment path.

## Why Cloudflare

Everything fits inside the free tier, verified against current limits:

| | Free tier | Needed at 200 participants |
|---|---|---|
| Workers | 100,000 req/day, 10 ms CPU, **no wall-clock limit** | ~15,000 |
| Queues | 10,000 ops/day | ~3,000 |
| D1 | 100k writes, 5M reads/day, 5 GB | ~5,000 writes, ~2 MB |
| Universal SSL | apex + **one** subdomain level | `aimpact.` and `{slug}.` are both one level |

**No R2.** Published pages live in the D1 `pages` table. Two reasons: R2 needs
dashboard activation and a payment method even inside its free tier, and — the
one that would still apply if it were free — writing the page and marking the
job done becomes a single `db.batch`. A two-phase write across two services can
half-fail, leaving a job marked done with no page behind it: a participant shown
a URL that 404s in front of a customer. R2 becomes the right answer the day
participants upload photos, which the current design does not do.

Nine AWS services become four, and the NAT Gateway trap — the largest cost risk
in the AWS variant — cannot exist here.

## Status

| | |
|---|---|
| `src/model.ts` — shared types | done |
| `src/render.ts` — page renderer | done, 20 tests |
| `src/slug.ts` — subdomain labels | done, 16 tests |
| `src/auth.ts` — session tokens | done, 17 tests |
| `src/store.ts` — D1 access | done |
| `src/api.ts` — request handlers | done |
| `src/index.ts` — host routing, page serving | done |
| `src/consumer.ts` — Anthropic call, render, publish | done, 5 tests |
| `src/prompt.ts` — system prompt | done |
| Participant code seeding | done — 220 codes in D1, CSV for handouts |
| Deployment | done — zone active, routes attached, verified end to end |
| `web/` — builder UI | done, ported unchanged |

```bash
npm install
npm run check      # typecheck + tests
```

## The model writes the page

`src/prompt.ts` asks for a complete HTML document; `src/sanitize.ts` strips what
cannot be allowed to run. Two participants get visibly different sites, which is
the product — see design §5.1 for why this reversed an earlier decision, and
what risk it accepts.

`src/render.ts` and its template are gone. What replaced them:

| | |
|---|---|
| `sanitize.ts` | HTMLRewriter — drops script/iframe/form/on*/srcdoc/http-equiv, bad schemes, malformed attribute names; normalises every wa.me link |
| `index.ts` headers | `script-src 'none'` — the backstop if anything survives |
| `test/sanitize.test.ts` | runs in the Workers runtime; asserts on **element creation**, not substrings |

Tests run under `@cloudflare/vitest-pool-workers` because HTMLRewriter exists
only in that runtime. Note the pool's API changed in 0.22: `cloudflarePool` on
the main entry, not `defineWorkersConfig` from `/config` as older guides show.

## The one thing that got weaker moving off Go

The Go version used `html/template`, whose contextual auto-escaping made design
invariant §8.2 — no participant or model value becomes executable content — a
property of the standard library. JavaScript has no equivalent.

`src/render.ts` rebuilds the guarantee from two rules:

1. **`html` is a tagged template that escapes every interpolation.** Escaping is
   the default and cannot be forgotten. The failure mode of hand-written
   concatenation is that one insertion point gets missed, and one is enough.
2. **Every attribute in the template is quoted.** Escaping `&<>"'` is sufficient
   for text and quoted-attribute contexts; it is *not* sufficient for unquoted
   attributes, so those are prohibited.

The model supplies no URL, style or script. The only dynamic URL is built from
digits extracted by `waNumber`, so URL injection is impossible by construction
rather than by filtering.

`test/render.test.ts` carries the Go tests over verbatim — script, image, iframe
and anchor-breakout payloads — plus tests for the tagged template itself.

**This is still a downgrade**: "the platform guarantees it" became "we implement
it and test it". Treat `render.ts` as security-critical code and do not
interpolate into it without the `html` tag.

## Deploy

D1 already exists and the schema is applied:

```
aimpact  04fcb4af-48b9-4425-a7ad-487569fe01a3  (APAC)
```

Remaining:

```bash
npx wrangler queues create aimpact-generate
npx wrangler queues create aimpact-generate-dlq
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SESSION_SECRET   # any 32+ random chars
npm run deploy
```

DNS: the zone must be on Cloudflare (free plan requires full nameserver
delegation; CNAME setup is Business plan). Add a **proxied** wildcard `*` record
— Workers routes only apply to proxied hostnames. Leave the apex and `www`
**grey-clouded** so the existing Hostinger site and mailbox are untouched.

## Model call

`claude-opus-5` with structured output (`messages.parse` + `zodOutputFormat`), so
the model returns the fields of `SiteContent` and never markup — design §5.1.

Three choices worth knowing about:

**`effort: "low"`.** Not a cost decision. A participant is watching a spinner,
and this is short extraction-and-copy work rather than reasoning — the workload
shape where higher effort buys little. It is the first dial to turn if output
quality disappoints, before changing model.

**The system prompt is byte-identical for every participant**, so it caches
after the first call and reads back at roughly a tenth of the input price.
Never interpolate per-request text into `src/prompt.ts`: one changed byte
invalidates the cache for everyone. Verify with `usage.cache_read_input_tokens`.

**Server-side refusal fallbacks are deliberately not wired.** A safety decline
arrives as HTTP 200 with `stop_reason: "refusal"`, and the consumer turns it
into a message asking the participant to rewrite. Rerouting to a second model
to satisfy a request the first declined is the wrong behaviour for a public
workshop run under an organisation's name.

Errors are split by whose fault they are: `ParticipantError` is terminal and
shows the participant something actionable, because retrying identical input
would spend another generation against the cap and fail the same way. Anything
else rethrows so the queue retries it.

## Two things that will bite you again

**`run_worker_first = true` is load-bearing.** Workers Assets serve static files
*before* the Worker runs for any path matching a file. Without that setting `/`
returned the builder UI on **every** hostname, so a participant visiting their
own page saw the code-entry screen instead. It never showed up on workers.dev,
where there are no participant subdomains and `/p/{slug}` doesn't match an
asset — only the real domain exposed it. Don't remove it.

**A failed deploy takes the site down rather than rolling back.** When a route
deploy failed on a missing token permission, wrangler had already removed the
workers.dev trigger and left the Worker with no trigger at all — its own words:
"Successful trigger changes were not rolled back." Deploy before a session, not
during one.

## Token permissions actually required

Assembled the hard way, one denial at a time:

| Scope | Resource | Level |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | Workers KV Storage | Edit |
| Account | D1 | Edit |
| Account | Queues | Edit |
| Account | Account Settings | Read |
| Zone | DNS | Edit |
| Zone | **Workers Routes** | **Edit** |
| Zone | Zone Settings | Edit |

Zone → Workers Routes is the one that looks redundant next to Workers Scripts
and is not: deploying the script and attaching it to a hostname are separate
permissions. Creating the zone itself needs `zone.create`, which none of these
grant — do that in the dashboard.

## Measured, not assumed (2026-09-10)

**Now running Claude Haiku 4.5.** Re-measure with `measure.py <model>` after any
model or prompt change — every number below moves.

| | Opus 5 | **Haiku 4.5** |
|---|---|---|
| output tokens / page | 2,544 | **1,939** |
| end to end | ~30 s | **~16-21 s** |
| 1,000 generations | $64.65 | **$10.49** |
| `max_concurrency` | 12 | **9** |
| 200 jobs drain in | 8.3 min | **5.9 min** |
| prompt caching | 975 tok/call | **none — see below** |

Two things worth understanding:

**Concurrency went *down*, not up.** Haiku finishes in half the time, so each
concurrent slot produces output tokens twice as fast. The same 80,000/min
ceiling is therefore reached with fewer slots: 12 would sit at 109% and start
returning 429s, 9 sits at 82%.

**Prompt caching stopped working.** `cache_read_input_tokens` is 0 on every
Haiku call, against 975 on Opus. The minimum cacheable prefix is model-dependent
and this system prompt (~975 tokens) falls below Haiku's. The cost impact is
negligible — input is $1/MTok and 800 uncached tokens is $0.0008 a call — but
do not assume caching is active on this model.

**`effort` is not sent to Haiku.** `output_config.effort` returns a 400 there;
`supportsEffort()` in `consumer.ts` omits it. Removing that guard breaks every
generation.

Account limits, read from the API response headers:

| | |
|---|---|
| requests | 1,000/min |
| input tokens | 500,000/min |
| **output tokens** | **80,000/min — the only one that binds** |

Three real generations, same system prompt and request shape as `consumer.ts`:

| | |
|---|---|
| output tokens | mean **2,544** (min 2,081, max 2,809) |
| page size | ~5,000 bytes |
| end-to-end | **~30 s** |
| `cache_read_input_tokens` | **975 on every call** — prompt caching confirmed working |

`max_concurrency = 12` follows from those: ~24 generations/min, ~61,000 output
tokens/min (~76% of the limit), 200 queued jobs draining in about 8 minutes.
15 would sit at 95% of the ceiling and 20 would exceed it.

Re-measure with `measure.py` before raising it — the numbers move with the
prompt, and output tokens include thinking.

## The reliability bottleneck was polling, not the model

Worked out 2026-09-10 for a 200-participant session (~1,000 generations):

| | of free tier |
|---|---|
| **Worker requests** | **121% — over** |
| D1 writes | 6% |
| D1 reads | 2% |
| Queue operations | 30% |

Nothing to do with Anthropic. The status endpoint was polled every 2 seconds,
and with a queue taking minutes to drain the average participant made ~120
requests. Exceeding 100,000/day returns **error 1027 and stops the Worker for
everyone** until midnight UTC — not degraded, stopped, mid-session.

Two fixes in `web/app.js`:

- **Backoff**: 2s for the first 30 seconds, 5s to 90 seconds, 10s after. A
  four-minute wait costs 42 polls instead of 120. Budget goes 121% → **43%**.
- **Elapsed time on the waiting screen.** Someone at the back of the queue
  waits minutes while the copy says "sekitar 30 detik"; without a counter that
  reads as broken and they resubmit, spending another generation and making the
  queue longer for everyone.

If this is ever run for materially more than 200 people, **Workers Paid is $5/month**
and removes the ceiling. For one session the backoff is enough.
