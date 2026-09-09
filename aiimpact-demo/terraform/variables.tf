variable "region" {
  description = "Primary AWS region. ap-southeast-3 is Jakarta; ap-southeast-1 (Singapore) is the fallback if a service is unavailable."
  type        = string
  default     = "ap-southeast-3"
}

variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "aiimpact"
}

variable "domain" {
  description = "Apex domain. Pages are served at {slug}.{domain}."
  type        = string
  default     = "iaitbjambi.org"
}

variable "anthropic_model" {
  description = "Model ID used by the generation worker."
  type        = string
  default     = "claude-opus-5"
}

variable "worker_concurrency" {
  description = "Reserved concurrency for the generation worker. This is the throttle that keeps a 200-request burst from hitting the Anthropic rate limit."
  type        = number
  default     = 8
}

variable "max_generations_per_participant" {
  description = "Hard per-participant cap. Bounds worst-case spend."
  type        = number
  default     = 15
}

variable "wait_for_certificate" {
  description = "Block apply until the ACM certificate validates. DNS is managed outside AWS, so leave false on the first apply, add the CNAMEs from the acm_validation_records output, then set true and apply again."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch log retention. Keeps log storage from growing without bound."
  type        = number
  default     = 14
}

variable "billing_alarm_usd" {
  description = "Estimated-charges alarm threshold. Expected spend is far below this, so any alert means something is running that should not be. Set to 0 to disable."
  type        = number
  default     = 5
}

variable "billing_alarm_email" {
  description = "Address subscribed to the billing alarm. Empty disables the subscription."
  type        = string
  default     = ""
}
