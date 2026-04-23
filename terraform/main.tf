terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  required_version = ">= 1.2"
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  access_base_uri = var.custom_hostname
  discovery_uri   = "${var.custom_hostname}/.well-known/opencode"
  health_uri      = "${var.custom_hostname}/healthz"
  ai_gateway_permission_group_id = try(
    data.cloudflare_account_api_token_permission_groups_list.ai_gateway_run.result[0].id,
    data.cloudflare_account_api_token_permission_groups_list.ai_gateway_edit.result[0].id,
  )
}

data "cloudflare_account_api_token_permission_groups_list" "ai_gateway_run" {
  account_id = var.cloudflare_account_id
  max_items  = 1
  name       = urlencode("AI Gateway Run")
  scope      = "com.cloudflare.api.account"
}

data "cloudflare_account_api_token_permission_groups_list" "ai_gateway_edit" {
  account_id = var.cloudflare_account_id
  max_items  = 1
  name       = urlencode("AI Gateway Edit")
  scope      = "com.cloudflare.api.account"
}

resource "cloudflare_account_token" "ai_gateway_run" {
  account_id = var.cloudflare_account_id
  name       = "${var.worker_name} AI Gateway token"

  policies = [{
    effect = "allow"
    permission_groups = [{
      id = local.ai_gateway_permission_group_id
    }]
    resources = jsonencode({
      "com.cloudflare.api.account.${var.cloudflare_account_id}" = "*"
    })
  }]
}

resource "cloudflare_zero_trust_access_policy" "default" {
  account_id = var.cloudflare_account_id
  name       = "${var.worker_name} allow policy"
  decision   = "allow"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_policy" "public_bypass" {
  account_id = var.cloudflare_account_id
  name       = "${var.worker_name} public bypass"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "opencode" {
  account_id                 = var.cloudflare_account_id
  name                       = "OpenCode Access Gateway"
  type                       = "self_hosted"
  domain                     = local.access_base_uri
  app_launcher_visible       = false
  http_only_cookie_attribute = true
  session_duration           = "24h"
  skip_interstitial          = true

  destinations = [
    {
      type = "public"
      uri  = local.access_base_uri
    },
    {
      type = "public"
      uri  = "${local.access_base_uri}/*"
    },
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.default.id
    precedence = 1
  }]
}

resource "cloudflare_zero_trust_access_application" "public_discovery" {
  account_id           = var.cloudflare_account_id
  name                 = "OpenCode Access Gateway discovery"
  type                 = "self_hosted"
  domain               = local.discovery_uri
  app_launcher_visible = false

  destinations = [{
    type = "public"
    uri  = local.discovery_uri
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.public_bypass.id
    precedence = 1
  }]
}

resource "cloudflare_zero_trust_access_application" "public_healthz" {
  account_id           = var.cloudflare_account_id
  name                 = "OpenCode Access Gateway healthz"
  type                 = "self_hosted"
  domain               = local.health_uri
  app_launcher_visible = false

  destinations = [{
    type = "public"
    uri  = local.health_uri
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.public_bypass.id
    precedence = 1
  }]
}

resource "cloudflare_workers_kv_namespace" "config_cache" {
  account_id = var.cloudflare_account_id
  title      = "${var.worker_name}-config-cache"
}

resource "cloudflare_d1_database" "users" {
  account_id = var.cloudflare_account_id
  name       = "${var.worker_name}-users"

  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_workers_script" "opencode" {
  account_id     = var.cloudflare_account_id
  script_name    = var.worker_name
  main_module    = var.worker_bundle_name
  content_file   = var.worker_bundle_path
  content_sha256 = filesha256(var.worker_bundle_path)
  assets = {
    directory = "${path.root}/../public"
  }
  compatibility_date  = "2026-04-20"
  compatibility_flags = ["nodejs_compat"]

  bindings = [
    {
      name = "TEAM_DOMAIN"
      text = var.team_domain
      type = "plain_text"
    },
    {
      name = "ASSETS"
      type = "assets"
    },
    {
      name         = "CONFIG_CACHE"
      namespace_id = cloudflare_workers_kv_namespace.config_cache.id
      type         = "kv_namespace"
    },
    {
      id   = cloudflare_d1_database.users.id
      name = "USER_DB"
      type = "d1"
    },
    {
      name = "POLICY_AUD"
      text = cloudflare_zero_trust_access_application.opencode.aud
      type = "plain_text"
    },
    {
      name = "CLOUDFLARE_ACCOUNT_ID"
      text = var.cloudflare_account_id
      type = "plain_text"
    },
    {
      name = "AIG_GATEWAY_ID"
      text = var.aig_gateway_id
      type = "plain_text"
    },
    {
      name = "AIG_AUTH_TOKEN"
      text = cloudflare_account_token.ai_gateway_run.value
      type = "secret_text"
    },
    {
      name = "AIG_LOG_PAYLOADS"
      text = var.aig_log_payloads
      type = "plain_text"
    },
    {
      name = "OPENCODE_PROVIDER_ID"
      text = var.opencode_provider_id
      type = "plain_text"
    },
    {
      name = "OPENCODE_PROVIDER_NAME"
      text = var.opencode_provider_name
      type = "plain_text"
    },
  ]

  observability = {
    enabled            = true
    head_sampling_rate = 1
  }
}

resource "cloudflare_workers_custom_domain" "main" {
  account_id = var.cloudflare_account_id
  hostname   = var.custom_hostname
  service    = cloudflare_workers_script.opencode.script_name
  zone_id    = var.cloudflare_zone_id
}

resource "cloudflare_workers_script_subdomain" "disabled" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.opencode.script_name
  enabled          = false
  previews_enabled = false
}
