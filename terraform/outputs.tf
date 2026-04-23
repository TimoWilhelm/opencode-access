output "policy_aud" {
  description = "Cloudflare Access audience tag used by the Worker."
  value       = cloudflare_zero_trust_access_application.opencode.aud
}

output "worker_url" {
  description = "Base URL for the deployed Worker."
  value       = "https://${var.custom_hostname}"
}

output "discovery_url" {
  description = "OpenCode discovery URL."
  value       = "https://${var.custom_hostname}/.well-known/opencode"
}

output "ai_gateway_token_id" {
  description = "Scoped AI Gateway token identifier."
  value       = cloudflare_account_token.ai_gateway_run.id
}

output "user_db_id" {
  description = "Anonymous user D1 database identifier."
  value       = cloudflare_d1_database.users.id
}

output "user_db_name" {
  description = "Anonymous user D1 database name."
  value       = cloudflare_d1_database.users.name
}

output "config_cache_kv_id" {
  description = "KV namespace identifier for the anonymous user cache."
  value       = cloudflare_workers_kv_namespace.config_cache.id
}
