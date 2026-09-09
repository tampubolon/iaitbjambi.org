# Terraform — AIMPACT demo stack

Infrastructure for the design in [`../README.md`](../README.md). Validated against Terraform 1.12, AWS provider ~> 5.60.

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

## Not included

- Lambda handler logic — `src/cmd/api` returns 501, `src/cmd/worker` logs and acknowledges
- The Anthropic call and prompt (`internal/render` is written and tested; the model call is not)
- Participant code generation
- Remote state backend — add an S3 backend before more than one person applies

## Layout

```
src/
├── cmd/api/          API Gateway handler
├── cmd/worker/       SQS consumer
└── internal/
    ├── model/        shared types, incl. SiteContent (fields, never markup)
    └── render/       html/template renderer + escaping tests
web/
├── index.html        builder UI, served at aimpact.<domain>
└── app.js            separate file so CSP stays at script-src 'self'
```

Publish the UI with `make app` (S3 copy + CloudFront invalidation). It has no
build step: on venue wifi with 200 phones, the cheapest bundle is the one that
does not exist.

`internal/render` is the security-critical package. `html/template` escapes by
context, so no participant or model value can become executable content —
README section 5.1. `render_test.go` asserts this against script, image,
iframe and anchor-breakout payloads.
