data "aws_caller_identity" "current" {}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name        = var.project
  bucket_name = "${var.project}-sites-${random_id.suffix.hex}"
  wildcard    = "*.${var.domain}"
}
