# AIMPACT Demo — AI Landing Page Builder

Technical design for the hands-on landing-page session at **Seminar AI for UMKM 2026 (AIMPACT)**, and for its continuation under Jambi Digital Movement.

**Status:** design — not yet built
**Owner:** IA-ITB Pengda Jambi
**Target scale:** 200 concurrent participants, 5-hour session

---

## 1. Problem

UMKM owners in Jambi need a web presence they can share on WhatsApp. Most have no laptop, no domain, and no experience with any website tool.

Existing consumer tools solve this adequately — Canva's free tier publishes an AI-generated site from a phone, and Lynk.id registers via WhatsApp OTP with no install. **They remain the right answer for the seminar itself** (see §12). This project exists for a different reason: to give Jambi Digital Movement an owned, durable platform for the "AI untuk semua" inclusion programme, where the pages live under our domain and the participant list is ours.

**Goal:** a participant with only a phone types a description of their business, and within seconds has a live landing page at a memorable URL with a working WhatsApp order button.

**URLs**

| | |
|---|---|
| `aimpact.iaitbjambi.org` | Builder UI — where participants enter a code and type their prompt |
| `aimpact.iaitbjambi.org/api/*` | API, same-origin via CloudFront |
| `{slug}.iaitbjambi.org` | A participant's published page |

## 2. Non-goals

- Not a website *editor*. No canvas, no drag-and-drop, no layout control.
- Not a chat. One prompt in, one page out — no conversational refinement.
- Not multi-page. One page per business.
- Not a CMS. Content changes by re-submitting the form, not by editing HTML.
- Not e-commerce. The call to action is a WhatsApp link, not a checkout.
- No custom domains in v1.

## 3. Users and scale

| | |
|---|---|
| Participants | 200 |
| Session length | 5 hours |
| Expected generations | ~5 per user (~1,000 total) |
| Hard cap | 15 per user (~3,000 total) |
| Device | Android phone, mobile data, variable connectivity |
| Technical skill | None assumed |

**Load is not uniform.** Average demand is ~3 generations/minute, which is nothing. The real design load is the **spike**: when the presenter says "everyone try it now", ~200 submissions arrive within 30 seconds. That burst, repeated three or four times, is what the system must survive.

## 4. Architecture

The builder UI is a single static page plus one script, served from the same
CloudFront distribution as the published pages. The viewer-request function
routes by hostname: `aimpact.` goes to `app/`, anything else to `sites/{slug}/`.
`/api/*` is its own cache behaviour pointing at API Gateway, which makes every
call from the UI same-origin — no CORS preflight on a slow connection.

```
  phone browser  ── aimpact.iaitbjambi.org ──> S3 app/  (UI, static)
       │  one-time code
       ▼
  ┌─────────────┐   POST /generate        ┌──────────┐
  │ API Gateway │ ──────────────────────► │  SQS     │
  │  (HTTP API) │   returns job_id        │  queue   │
  └─────────────┘                         └────┬─────┘
       │  GET /status/{job_id}                 │ capped concurrency (5–10)
       │                                       ▼
       │                              ┌──────────────────┐
       │                              │ Lambda: generate │
       │                              │  (no VPC)        │
       │                              └────┬─────────┬───┘
       ▼                                   │         │
  ┌──────────┐                             │         │ Anthropic API
  │ DynamoDB │ ◄───────────────────────────┘         │ (structured output)
  │  jobs    │        status                         ▼
  └──────────┘                              ┌─────────────────┐
                                            │ render template │
                                            └────────┬────────┘
                                                     │ PUT
                                                     ▼
                                               ┌──────────┐
                                               │    S3    │
                                               └────┬─────┘
                                                    │ OAC
                                                    ▼
                                            ┌───────────────┐
                                            │  CloudFront   │
                                            │ *.iaitbjambi  │
                                            └───────────────┘
```

DNS stays with the current provider. A wildcard `CNAME` points at the CloudFront distribution; an ACM certificate for `*.iaitbjambi.org` is issued in **us-east-1** (required for CloudFront) and validated by a `CNAME`. **Existing MX, DKIM and mail records are untouched** — no nameserver migration.

## 5. Key design decisions

### 5.1 The model returns JSON, never HTML

The LLM emits structured fields — headline, tagline, three products with prices, CTA text — via the Messages API's structured output (`output_config.format`). Our own code renders the HTML from a fixed template.

This is the most important decision in the document, for three reasons:

1. **Security.** Pages are served from `*.iaitbjambi.org`, the organisation's real domain. If the model emitted markup, a participant could prompt it into injected script or a phishing-shaped page carrying IA-ITB's identity and the Pemerintah Kota Jambi association. A renderer that never emits `<script>` closes this by construction rather than by filtering.
2. **Recoverability.** A layman cannot debug broken AI-generated HTML. A template always produces a correct-looking page.
3. **Cost and latency.** ~700 output tokens of JSON instead of ~3,000 of markup.

### 5.2 Asynchronous submission

API Gateway hard-caps a request at **29 seconds**. A generation with a capable model can exceed that, and the failure mode is an opaque gateway error.

`POST /generate` enqueues and returns a `job_id` immediately. The browser polls `GET /status/{job_id}` every 2 seconds. This also makes the queue natural rather than retrofitted.

### 5.3 Queue with capped worker concurrency

Anthropic API rate limits are per-organisation and tier-based. 200 simultaneous requests from an entry tier will return `429`.

SQS absorbs the burst; workers run at a fixed reserved concurrency of **5–10**. Users see *"sedang diproses…"* for a few seconds instead of an error. SDK retry with jitter handles residual `429`s.

### 5.4 No VPC, therefore no NAT Gateway

The Lambda needs outbound access to the Anthropic API, S3 and DynamoDB. A Lambda **outside** a VPC has this for free.

Attaching it to a VPC would break internet access and the obvious fix — a NAT Gateway — costs **~$32/month running or not**, which is more than the entire project. There is no security gain to trade against it: the function has no inbound exposure and is invoked only by API Gateway.

**Invariant: this project creates no VPC, no NAT Gateway, and no EC2 instance.**

### 5.5 Subdomains are business names, not account numbers

`nasigorengbudi.iaitbjambi.org`, never `account001.iaitbjambi.org`.

The entire value of the artifact is that the owner shares the link on WhatsApp. A numbered subdomain is meaningless to a customer and reads like spam. Slugs are derived from the business name, normalised, and de-duplicated with a numeric suffix.

### 5.6 A prompt box, seeded rather than blank

Input is free text — the participant describes their business in their own words, and the model extracts the fields.

A form would complete faster and more reliably; that was the alternative considered. The prompt box was chosen because the session's premise is teaching people to *use AI*, and a form hides the thing being taught.

The cost of that choice is blank-page paralysis, which is the usual failure mode. It is mitigated rather than accepted: the box opens **pre-filled with a complete, editable example** for a Jambi warung, and five tappable chips append the fields people most often omit — opening hours, address, WhatsApp number, delivery, what makes the food good. A participant who overwrites the example gets a good result; one who edits it gets a good result; only one who deletes it and stares at nothing does not, and that state is never the default.

Server-side, the model still returns **structured fields, not markup** (§5.1). Free text goes in; JSON comes out.

### 5.7 One-time codes, not usernames and passwords

Distributing 200 credentials means password resets during the session. Codes are pre-generated, printed on the participant handout, and redeemed once to establish a session. No password, no recovery flow, no support queue.

## 6. Data model

**DynamoDB `jobs`** — `job_id` (PK), `code`, `slug`, `status` (`queued|running|done|error`), `error_message`, `created_at`, `ttl` (7 days).

**DynamoDB `participants`** — `code` (PK), `slug`, `business_name`, `wa_number`, `generation_count`, `created_at`.

**S3** — `sites/{slug}/index.html`, `sites/{slug}/assets/*`.

## 7. API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/redeem` | Exchange a one-time code for a session token |
| `POST` | `/generate` | Enqueue a generation; returns `job_id` |
| `GET` | `/status/{job_id}` | Poll status; returns live URL when `done` |
| `GET` | `/me` | Current slug, remaining generations |

## 8. Invariants

1. A participant may never exceed **15 generations**, enforced server-side on `participants.generation_count`.
2. Rendered HTML contains no `<script>` and no attribute-borne JavaScript. Enforced by the renderer, not by sanitising model output.
3. `slug` is unique and immutable once assigned.
4. A published page is durable. Republishing overwrites; nothing expires.
5. No AWS resource in this project bills while idle.
6. The WhatsApp link uses country-code format (`628…`), never local format (`08…`).

## 9. Security

- **Content.** Covered by §5.1 — the model cannot emit markup.
- **Abuse.** Every endpoint requires a redeemed code. The per-user cap bounds spend on a stolen code.
- **Uploads.** Photos are content-type checked, re-encoded server-side, and size-capped. Re-encoding strips EXIF, including GPS.
- **Secrets.** The Anthropic API key lives in Secrets Manager, read at cold start. Never in code, environment variables in source, or this repository.
- **S3.** Bucket is private; CloudFront reads via Origin Access Control. No public bucket policy.
- **Personal data.** Names, WhatsApp numbers and photos are personal data under UU PDP. Consent is collected at redemption; retention and a deletion path are stated on the page footer. Participants can request removal by WhatsApp.

## 10. Cost

At 200 users, ~1,000 generations, with prompt caching (the system prompt is byte-identical across all participants, so it caches after the first call).

| Model | Per generation | Demo day | Full project |
|---|---|---|---|
| Claude Opus 5 | $0.019 | $19 | ~$40 |
| Claude Sonnet 5 | $0.008 | $8 | ~$16 |

AWS, all services, is **under $0.30** — Lambda's 400,000 GB-s and CloudFront's 1 TB are always-free tiers, unaffected by account age.

*Full project* includes prompt iteration, a load test, and a dry run. Worst case at the 15-generation cap is ~$78 on Opus 5.

**Controls:** Anthropic organisation spend limit of **$100** (a hard ceiling, not an alert); AWS billing alarm at **$5** — at expected usage it should never fire, so any alert means something is running that shouldn't be.

Cost should not influence any technical decision here. Choose for reliability in a live room.

## 11. Capacity

| Concern | Mitigation |
|---|---|
| 200-request burst | SQS + reserved concurrency 5–10 |
| Anthropic rate limit | Confirm org tier **weeks ahead**; request an increase if on entry tier |
| API Gateway 29s cap | Async submit/poll (§5.2) |
| Lambda duration | Timeout 120s; billed on actual duration |
| Venue wifi | Out of our control. Advise mobile data; confirm venue AP capacity |

## 12. Rollout

This platform **does not debut at the seminar on 17 September 2026.**

New infrastructure with a DNS dependency, a certificate dependency, and an LLM in the request path, in front of the Walikota and sponsors, against a public commitment that ≥70% of participants leave with a usable asset — the risk is not justified when a free, proven alternative exists.

| Phase | When | Content |
|---|---|---|
| 0 | Now → 16 Sep | DNS wildcard + ACM certificate issued and verified |
| 1 | Seminar, 17 Sep | **Canva** for the hands-on session. No custom platform. |
| 2 | Oct | Build; prompt iteration; load test at 200 concurrent |
| 3 | Late Oct | Dry run, ~20 real participants, own phones, mobile data |
| 4 | Nov onward | JDM programme delivery |

DNS and certificate work happens in phase 0 regardless — propagation and validation are not things to discover on the morning.

## 13. Verification

- **Load test.** 200 concurrent submissions from a script. Assert: no `5xx`, no `429` reaching a user, p95 end-to-end under 20s. This is the single highest-value pre-flight task.
- **Renderer safety.** Adversarial prompts attempting script injection, external images, iframes, and `javascript:` URLs. Assert none survive into output.
- **Cap enforcement.** 16th generation on one code is rejected.
- **Slug collision.** Two participants submitting the same business name get distinct URLs.
- **WhatsApp link.** Generated `wa.me` link opens a chat with the correct number from a real phone.
- **Cold path.** First request after idle completes within timeout.
- **Cost.** Reconcile actual spend against §10 after the load test; investigate any variance above 2×.

## 14. Risks and open questions

| Risk | Severity | Mitigation |
|---|---|---|
| Anthropic rate limit at entry tier | **High** | Verify tier now; increases take lead time |
| Venue network fails | **High** | Mobile data; out of our control |
| A NAT Gateway is created accidentally | Medium | §5.4 invariant; billing alarm at $5 |
| Slug squatting / offensive names | Medium | Denylist; slugs reviewable and revocable |
| Photo upload dominates page weight | Medium | Server-side re-encode and resize |
| Participants expect editing | Low | Set expectations: re-submit, don't edit |

**Open questions**

1. What is our current Anthropic API tier and rate limit? *(blocks §11 — resolve first)*
2. Do pages persist indefinitely, or expire if unclaimed? Assumed indefinite.
3. Who operates this after November — JDM, or IA-ITB?
4. Bahasa Indonesia only, or Melayu Jambi variants in generated copy?
5. Does a participant get a preview before publishing, or is publish immediate? Assumed immediate — a preview step is another screen to explain.

## 15. Assumptions

- 5 generations per participant on average; 15 is a hard cap.
- ~700 output tokens per generation with structured output.
- Prompt caching holds across the session (identical system prompt).
- Participants arrive with photos already on their phones.
- DNS remains with the current provider; no nameserver migration.
- AWS account is outside the 12-month free tier; always-free tiers still apply.
