# ---------------------------------------------------------------------------
# Both functions run OUTSIDE a VPC. This is deliberate and load-bearing:
# a VPC-attached Lambda loses internet egress, and restoring it needs a NAT
# Gateway at ~$32/month whether or not anything runs -- more than this entire
# project costs. Neither function touches a private resource, so there is
# nothing a VPC would protect.
# ---------------------------------------------------------------------------

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/src/api"
  output_path = "${path.module}/.build/api.zip"
}

data "archive_file" "worker" {
  type        = "zip"
  source_dir  = "${path.module}/src/worker"
  output_path = "${path.module}/.build/worker.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --- API function -----------------------------------------------------------

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }

  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.jobs.arn,
      aws_dynamodb_table.participants.arn,
      "${aws_dynamodb_table.participants.arn}/index/slug-index",
    ]
  }

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.generate.arn]
  }
}

resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.name}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      JOBS_TABLE         = aws_dynamodb_table.jobs.name
      PARTICIPANTS_TABLE = aws_dynamodb_table.participants.name
      QUEUE_URL          = aws_sqs_queue.generate.url
      DOMAIN             = var.domain
      MAX_GENERATIONS    = tostring(var.max_generations_per_participant)
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

# --- Generation worker ------------------------------------------------------

resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "worker" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.worker.arn}:*"]
  }

  statement {
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.generate.arn]
  }

  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.jobs.arn, aws_dynamodb_table.participants.arn]
  }

  # Write only under sites/ -- the worker never needs to read or delete.
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.sites.arn}/sites/*"]
  }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.anthropic.arn]
  }
}

resource "aws_iam_role_policy" "worker" {
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_lambda_function" "worker" {
  function_name    = "${local.name}-worker"
  role             = aws_iam_role.worker.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256

  # Generation can take tens of seconds. Billed on actual duration, so a
  # generous ceiling costs nothing and avoids truncating a slow call.
  timeout     = 120
  memory_size = 512

  # The throttle. Caps concurrent calls to Anthropic so a queue backlog
  # drains at a sustainable rate instead of producing a wall of 429s.
  reserved_concurrent_executions = var.worker_concurrency

  environment {
    variables = {
      JOBS_TABLE         = aws_dynamodb_table.jobs.name
      PARTICIPANTS_TABLE = aws_dynamodb_table.participants.name
      SITES_BUCKET       = aws_s3_bucket.sites.id
      ANTHROPIC_SECRET   = aws_secretsmanager_secret.anthropic.arn
      ANTHROPIC_MODEL    = var.anthropic_model
      DOMAIN             = var.domain
    }
  }

  depends_on = [aws_cloudwatch_log_group.worker]
}

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn                   = aws_sqs_queue.generate.arn
  function_name                      = aws_lambda_function.worker.arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
}
