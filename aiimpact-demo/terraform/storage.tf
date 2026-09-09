# ---------------------------------------------------------------------------
# Published pages. Private bucket; CloudFront reads it through OAC.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "sites" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_public_access_block" "sites" {
  bucket                  = aws_s3_bucket.sites.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sites" {
  bucket = aws_s3_bucket.sites.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "sites" {
  bucket = aws_s3_bucket.sites.id
  versioning_configuration {
    status = "Enabled"
  }
}

# A participant who regenerates 15 times leaves 15 object versions behind.
# Keep recent history for rollback, drop the rest.
resource "aws_s3_bucket_lifecycle_configuration" "sites" {
  bucket = aws_s3_bucket.sites.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "sites_bucket" {
  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.sites.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.sites.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "sites" {
  bucket = aws_s3_bucket.sites.id
  policy = data.aws_iam_policy_document.sites_bucket.json
}

# ---------------------------------------------------------------------------
# State. On-demand billing: no idle cost, and the volumes here are trivial.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "jobs" {
  name         = "${local.name}-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "job_id"

  attribute {
    name = "job_id"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }
}

resource "aws_dynamodb_table" "participants" {
  name         = "${local.name}-participants"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "code"

  attribute {
    name = "code"
    type = "S"
  }

  attribute {
    name = "slug"
    type = "S"
  }

  # Enforces slug uniqueness lookups without a table scan.
  global_secondary_index {
    name            = "slug-index"
    hash_key        = "slug"
    projection_type = "KEYS_ONLY"
  }
}

# ---------------------------------------------------------------------------
# Anthropic API key. Created empty; populate out of band with
#   aws secretsmanager put-secret-value --secret-id <id> --secret-string '{"api_key":"sk-ant-..."}'
# The value is deliberately not managed by Terraform so it never enters state.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "anthropic" {
  name                    = "${local.name}/anthropic-api-key"
  recovery_window_in_days = 0
}
