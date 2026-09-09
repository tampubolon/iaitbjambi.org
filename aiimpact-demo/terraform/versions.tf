terraform {
  required_version = ">= 1.6"

  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.60" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "aiimpact-demo"
      Owner     = "IA-ITB Pengda Jambi"
      ManagedBy = "terraform"
    }
  }
}

# CloudFront requires its certificate in us-east-1, regardless of where the
# rest of the stack lives.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project   = "aiimpact-demo"
      Owner     = "IA-ITB Pengda Jambi"
      ManagedBy = "terraform"
    }
  }
}
