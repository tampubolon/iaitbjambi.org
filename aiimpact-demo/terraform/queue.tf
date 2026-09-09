# Absorbs the submission burst. When the presenter says "everyone try it now",
# ~200 requests arrive inside 30 seconds; the queue holds them while the worker
# drains at a rate the Anthropic rate limit tolerates.

resource "aws_sqs_queue" "generate_dlq" {
  name                      = "${local.name}-generate-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "generate" {
  name                       = "${local.name}-generate"
  visibility_timeout_seconds = 180 # >= worker timeout (120s) plus headroom
  message_retention_seconds  = 3600
  receive_wait_time_seconds  = 20 # long polling

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.generate_dlq.arn
    maxReceiveCount     = 3
  })
}
