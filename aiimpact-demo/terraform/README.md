# Terraform — AIMPACT demo stack

Infrastructure for the design in [`../README.md`](../README.md). Validated against Terraform 1.12, AWS provider ~> 5.60.

## What it builds

| | |
|---|---|
| S3 | Private bucket for published pages, versioned, 30-day non-current expiry |
| CloudFront | Wildcard distribution + OAC + subdomain→path rewrite function + security headers |
| ACM | `*.iaitbjambi.org` in us-east-1, DNS validation |
| Lambda | `api` (10s) and `worker` (120s, reserved concurrency 8) — **both outside any VPC** |
| SQS | Generation queue + DLQ, 3 attempts |
| DynamoDB | `jobs` (TTL 7d) and `participants` (slug GSI), on-demand |
| API Gateway | HTTP API, 4 routes, access logging |
| Secrets Manager | Anthropic API key, created empty |
| CloudWatch | Log groups (14d), billing alarm, DLQ and backlog alarms |

## Deploy

The certificate needs DNS records added by hand, so the first apply runs in two passes.

```bash
cp terraform.tfvars.example terraform.tfvars   # then edit
terraform init
terraform apply                                # wait_for_certificate = false
```

Take `acm_validation_records` and `dns_records_required` from the output and add them at the DNS provider. **Do not migrate nameservers** — add records only, so existing MX and DKIM entries are untouched.

```bash
# once the CNAMEs have propagated
terraform apply -var wait_for_certificate=true
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

- Lambda handler logic — `src/api` and `src/worker` are stubs that deploy and return 501
- The page template and Anthropic prompt
- Participant code generation
- Remote state backend — add an S3 backend before more than one person applies
