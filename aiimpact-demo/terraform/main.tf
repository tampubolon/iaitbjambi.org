data "aws_caller_identity" "current" {}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name        = var.project
  bucket_name = "${var.project}-sites-${random_id.suffix.hex}"
  wildcard    = "*.${var.domain}"
}

# Signs participant session tokens. Must be identical across every instance of
# the API function -- a per-instance secret would look like random logouts
# under Lambda concurrency. Held in state, never in source.
resource "random_password" "session_secret" {
  length  = 48
  special = false
}
