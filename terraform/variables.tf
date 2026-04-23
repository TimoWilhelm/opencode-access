variable "cloudflare_api_token" {
  description = "Cloudflare API token used by Terraform."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Zone ID for the custom hostname."
  type        = string
}

variable "team_domain" {
  description = "Full Cloudflare Access team domain URL."
  type        = string
}

variable "custom_hostname" {
  description = "Custom hostname for the Worker deployment."
  type        = string
}

variable "worker_name" {
  description = "Cloudflare Worker name."
  type        = string
  default     = "opencode-access"
}

variable "worker_bundle_name" {
  description = "Generated Worker bundle filename."
  type        = string
}

variable "worker_bundle_path" {
  description = "Generated Worker bundle absolute path."
  type        = string
}

variable "aig_gateway_id" {
  description = "AI Gateway identifier."
  type        = string
  default     = "opencode-access"
}

variable "aig_log_payloads" {
  description = "Whether the Worker asks AI Gateway to collect request/response payloads."
  type        = string
  default     = "false"
}

variable "opencode_provider_id" {
  description = "Provider ID exposed in the discovery document."
  type        = string
  default     = "cloudflare-access-gateway"
}

variable "opencode_provider_name" {
  description = "Provider name exposed in the discovery document."
  type        = string
  default     = "Cloudflare Access Gateway"
}
