resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.name}-worker"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.name}"
  retention_in_days = var.log_retention_days
}

# --- Billing alarm ----------------------------------------------------------
# Estimated charges are only published in us-east-1. Expected spend for this
# project is under a dollar, so this alarm firing means something is running
# that should not be -- a NAT Gateway, a forgotten instance, a stray volume.

resource "aws_sns_topic" "alarms" {
  count = var.billing_alarm_usd > 0 ? 1 : 0
  name  = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "alarms_email" {
  count     = var.billing_alarm_usd > 0 && var.billing_alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.billing_alarm_email
}

resource "aws_cloudwatch_metric_alarm" "billing" {
  count               = var.billing_alarm_usd > 0 ? 1 : 0
  provider            = aws.us_east_1
  alarm_name          = "${local.name}-estimated-charges"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "EstimatedCharges"
  namespace           = "AWS/Billing"
  period              = 21600
  statistic           = "Maximum"
  threshold           = var.billing_alarm_usd
  dimensions          = { Currency = "USD" }
  alarm_description   = "Estimated charges exceeded $${var.billing_alarm_usd}. Check for a NAT Gateway, EC2 instance, or unattached EBS volume."
  alarm_actions       = var.billing_alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []
}

# --- Operational alarms -----------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  count               = var.billing_alarm_usd > 0 ? 1 : 0
  alarm_name          = "${local.name}-dlq-not-empty"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  dimensions          = { QueueName = aws_sqs_queue.generate_dlq.name }
  alarm_description   = "Generation jobs are failing past the retry limit."
  alarm_actions       = var.billing_alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []
}

resource "aws_cloudwatch_metric_alarm" "queue_backlog" {
  count               = var.billing_alarm_usd > 0 ? 1 : 0
  alarm_name          = "${local.name}-queue-backlog"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 120
  dimensions          = { QueueName = aws_sqs_queue.generate.name }
  alarm_description   = "Oldest queued job is over 2 minutes old. Participants are waiting; consider raising worker_concurrency if the Anthropic rate limit allows."
  alarm_actions       = var.billing_alarm_email != "" ? [aws_sns_topic.alarms[0].arn] : []
}
