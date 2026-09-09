# Terraform — AIMPACT demo stack (AWS variant)

> **Not the active deployment target.** The project runs on Cloudflare's free
> plan — see [`../cloudflare/`](../cloudflare/). This stack is complete and
> `terraform validate` passes; it is kept because the decisions recorded here
> (no VPC therefore no NAT Gateway, the async submit/poll shape, the queue as
> rate-limit throttle) still hold, and because it becomes viable again the day
> an AWS account exists.


Infrastructure and Go services for the design in [`../README.md`](../README.md).

Validated against Terraform 1.12 and AWS provider ~> 5.60. **Go 1.24 or newer is
required** — the AWS SDK v2 will not resolve below it. If your `go` binary is
older it will fetch a newer toolchain automatically; do not set
`GOTOOLCHAIN=local` on a build host or the SDK fails to resolve.

## What it builds

| | |
|---|---|
| S3 | Private bucket for published pages, versioned, 30-day non-current expiry |
| CloudFront | Wildcard distribution + OAC + hostname routing (`aimpact.`→`app/`, else `sites/{slug}/`) + `/api/*` behaviour to API Gateway + security headers |
| ACM | `*.iaitbjambi.org` in us-east-1, DNS validation |
| Lambda | Go on `provided.al2023`/arm64 — `api` (10s) and `worker` (120s, reserved concurrency 8), **both outside any VPC** |
| SQS | Generation queue + DLQ, 3 attempts |
| DynamoDB | `jobs` (TTL 7d) and `participants` (slug GSI), on-demand |
| API Gateway | HTTP API, 4 routes, access logging |
| Secrets Manager | Anthropic API key, created empty |
| random_password | Session-token signing secret, injected into the API function |
| CloudWatch | Log groups (14d), billing alarm, DLQ and backlog alarms |

## Build

Terraform consumes prebuilt zips, so compile first. `make plan` and `make apply` do it for you.

```bash
make build      # go test, cross-compile linux/arm64, package
```

Go targets arm64 (Graviton): cheaper per GB-second and the native target. A static
binary means no dependency packaging at all — no layer, no bundler, no node_modules.

`scripts/package.py` sets the executable bit on `bootstrap` explicitly, because
`provided.al2023` refuses to start without it, and writes a fixed timestamp so an
unchanged binary produces an identical zip and Terraform sees no spurious diff.

## Deploy

The certificate needs DNS records added by hand, so the first apply runs in two passes.

```bash
cp terraform.tfvars.example terraform.tfvars   # then edit
terraform init
make apply                                     # wait_for_certificate = false
```

Take `acm_validation_records` and `dns_records_required` from the output and add them at the DNS provider. **Do not migrate nameservers** — add records only, so existing MX and DKIM entries are untouched.

```bash
# once the CNAMEs have propagated
make build && terraform apply -var wait_for_certificate=true
```

Then load the API key. It is deliberately not managed by Terraform, so it never enters state:

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(terraform output -raw anthropic_secret_arn)" \
  --secret-string '{"api_key":"sk-ant-..."}'
```

## Cost invariants

Verify after any change to this stack:

- **No VPC on either Lambda.** A VPC-attached function loses internet egress; restoring it needs a NAT Gateway at ~$32/month running or not — more than the whole project. Neither function touches a private resource.
- **No EC2, no provisioned capacity.** Everything here bills per request.
- **`terraform plan` shows no `aws_nat_gateway`, `aws_instance`, or `aws_db_instance`.**

Expected spend is under $0.30 for a 200-participant session; Lambda's 400,000 GB-s and CloudFront's 1 TB are always-free tiers unaffected by account age. The billing alarm at $5 exists to catch a mistake, not to track normal usage.

## Status

Done and tested:

- All infrastructure
- The builder UI (`web/`)
- `cmd/api` — `redeem`, `generate`, `status`, `me`, working against DynamoDB and SQS
- `internal/render`, `internal/slug`, `internal/auth`, `internal/store`

Not yet built:

- **`cmd/worker`** — logs the message and acknowledges it. The Anthropic call,
  the prompt, the slug claim and the S3 publish are all missing, so a job
  queues and then sits at `queued` forever. This is the last piece before the
  system runs end to end.
- **Participant code seeding** — no codes exist, so `redeem` finds nothing.
- **Remote state backend** — add an S3 backend before more than one person applies.

## Layout

```
src/
├── cmd/api/          API Gateway handler — 4 routes
├── cmd/worker/       SQS consumer — stub
└── internal/
    ├── auth/         HMAC session tokens, 12h
    ├── model/        shared types, incl. SiteContent (fields, never markup)
    ├── render/       html/template renderer + escaping tests
    ├── slug/         business name -> subdomain label, dedup, reserved list
    └── store/        DynamoDB access; conditional writes for the cap and slug
web/
├── index.html        builder UI, served at aimpact.<domain>
└── app.js            separate file so CSP stays at script-src 'self'
```

`make test` runs the Go tests; `make build` runs them before packaging, so a
broken test cannot be deployed.

Publish the UI with `make app` (S3 copy + CloudFront invalidation). It has no
build step: on venue wifi with 200 phones, the cheapest bundle is the one that
does not exist.

## The two packages worth reading first

`internal/render` is security-critical. `html/template` escapes by context, so
no participant or model value can become executable content (design §5.1/§8.2).
`render_test.go` asserts this against script, image, iframe and anchor-breakout
payloads, and covers the `08…` → `62…` WhatsApp conversion that otherwise
produces a button that silently opens nothing.

`internal/store` holds the two operations that are contended under a
200-person burst, both written as conditional writes rather than
read-then-write:

- `CountGeneration` — atomic `ADD` gated on the cap. This is what bounds
  worst-case spend, so a check-then-act version would be wrong under exactly
  the load the system is built for.
- `ClaimSlug` — gated on `attribute_not_exists(slug)`. The `slug-index` GSI is
  eventually consistent and can report a stale free; this condition is the
  actual guarantee.
