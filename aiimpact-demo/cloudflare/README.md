# Cloudflare Worker — AIMPACT demo

Implementation of [`../README.md`](../README.md) on Cloudflare's free plan.

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
| Participant code seeding | **not started** — no codes exist, so `redeem` finds nothing |
| `web/` — builder UI | done, ported unchanged |

```bash
npm install
npm run check      # typecheck + tests
```

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
