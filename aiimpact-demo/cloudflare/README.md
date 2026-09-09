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
| D1 | 100k writes, 5M reads/day, 5 GB | ~5,000 writes |
| R2 | 10 GB | ~50 MB |
| Universal SSL | apex + **one** subdomain level | `aimpact.` and `{slug}.` are both one level |

Nine AWS services become four, and the NAT Gateway trap — the largest cost risk
in the AWS variant — cannot exist here.

## Status

| | |
|---|---|
| `src/model.ts` — shared types | done |
| `src/render.ts` — page renderer | done, 20 tests |
| `src/slug.ts` — subdomain labels | done, 16 tests |
| `src/auth.ts` — session tokens | **not started** |
| `src/store.ts` — D1 access | **not started** |
| `src/api.ts` — request handlers | **not started** |
| `src/consumer.ts` — queue consumer, Anthropic call | **not started** |
| `src/index.ts` — host routing | **not started** |
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

```bash
wrangler d1 create aimpact          # put the id in wrangler.toml
npm run db:apply
wrangler r2 bucket create aimpact-sites
wrangler queues create aimpact-generate
wrangler queues create aimpact-generate-dlq
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SESSION_SECRET
npm run deploy
```

DNS: the zone must be on Cloudflare (free plan requires full nameserver
delegation; CNAME setup is Business plan). Add a **proxied** wildcard `*` record
— Workers routes only apply to proxied hostnames. Leave the apex and `www`
**grey-clouded** so the existing Hostinger site and mailbox are untouched.
