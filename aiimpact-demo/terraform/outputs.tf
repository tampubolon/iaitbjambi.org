output "api_endpoint" {
  description = "Base URL for the participant-facing API."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "cloudfront_domain" {
  description = "Point a wildcard CNAME at this: *.<domain> -> this value."
  value       = aws_cloudfront_distribution.sites.domain_name
}

output "dns_records_required" {
  description = "Records to add at the DNS provider. Mail records are unaffected."
  value = {
    wildcard_cname = {
      name  = "*.${var.domain}"
      type  = "CNAME"
      value = aws_cloudfront_distribution.sites.domain_name
    }
  }
}

output "acm_validation_records" {
  description = "Add these at the DNS provider, then set wait_for_certificate = true and apply again."
  value = [
    for o in aws_acm_certificate.sites.domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}

output "sites_bucket" {
  description = "S3 bucket holding published pages."
  value       = aws_s3_bucket.sites.id
}

output "anthropic_secret_arn" {
  description = "Populate with: aws secretsmanager put-secret-value --secret-id <this> --secret-string '{\"api_key\":\"sk-ant-...\"}'"
  value       = aws_secretsmanager_secret.anthropic.arn
}

output "queue_url" {
  description = "Generation queue."
  value       = aws_sqs_queue.generate.url
}

output "cost_guardrails" {
  description = "Invariants worth re-checking after any change."
  value = {
    vpc_attached        = "none - Lambda runs outside a VPC, so no NAT Gateway is required"
    idle_cost           = "none - no EC2, no NAT, no provisioned capacity"
    worker_concurrency  = var.worker_concurrency
    per_participant_cap = var.max_generations_per_participant
  }
}

output "cloudfront_distribution_id" {
  description = "Used by `make app` to invalidate the builder UI after publishing."
  value       = aws_cloudfront_distribution.sites.id
}

output "domain_name" {
  description = "Apex domain, for constructing URLs."
  value       = var.domain
}

output "builder_url" {
  description = "Where participants go to create their page."
  value       = "https://aimpact.${var.domain}"
}
