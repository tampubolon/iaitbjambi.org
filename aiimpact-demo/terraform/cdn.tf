# ---------------------------------------------------------------------------
# Certificate. Must live in us-east-1 for CloudFront.
#
# DNS is managed outside AWS, so validation records are added by hand. First
# apply with wait_for_certificate = false, add the CNAMEs from the
# acm_validation_records output at the DNS provider, then set it true and
# apply again. Existing MX and DKIM records are untouched -- no nameserver
# migration is involved.
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "sites" {
  provider          = aws.us_east_1
  domain_name       = local.wildcard
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "sites" {
  count                   = var.wait_for_certificate ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.sites.arn
  validation_record_fqdns = [for o in aws_acm_certificate.sites.domain_validation_options : o.resource_record_name]

  timeouts {
    create = "60m"
  }
}

# ---------------------------------------------------------------------------
# Distribution
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "sites" {
  name                              = "${local.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "rewrite" {
  name    = "${local.name}-subdomain-rewrite"
  runtime = "cloudfront-js-2.0"
  code    = file("${path.module}/cloudfront/rewrite.js")
  publish = true
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${local.name}-security-headers"

  security_headers_config {
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
  }

  # Defence in depth. The renderer never emits script, so this policy should
  # never actually block anything -- if it does, the renderer has a bug.
  custom_headers_config {
    items {
      header   = "Content-Security-Policy"
      value    = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "sites" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.name} participant landing pages"
  default_root_object = "index.html"
  aliases             = [local.wildcard]

  # North America + Europe + Asia. PriceClass_All would add South America
  # and Oceania for no benefit to a Jambi audience.
  price_class = "PriceClass_200"

  origin {
    domain_name              = aws_s3_bucket.sites.bucket_regional_domain_name
    origin_id                = "s3-sites"
    origin_access_control_id = aws_cloudfront_origin_access_control.sites.id
  }

  # Fronting the API on the same hostname removes CORS entirely: no preflight
  # round trip on a slow connection, and no class of bug that only appears on
  # someone else's phone.
  origin {
    domain_name = replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")
    origin_id   = "apigw"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-sites"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Managed-CachingOptimized
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite.arn
    }
  }

  # A page is republished under the same key on every regeneration, so the
  # participant must not be served a stale copy while showing it to someone.
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/error.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/error.html"
    error_caching_min_ttl = 10
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "apigw"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Managed-CachingDisabled / Managed-AllViewerExceptHostHeader.
    # The host header must not be forwarded or API Gateway rejects the request.
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.sites.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
