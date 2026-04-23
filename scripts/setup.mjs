#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const ROOT = process.cwd();
const ENV_FILE = join(ROOT, ".env");
const ENV_EXAMPLE_FILE = join(ROOT, ".env.example");
const DIST_DIR = join(ROOT, "dist");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const TERRAFORM_DIR = join(ROOT, "terraform");
const TERRAFORM_TFVARS_FILE = join(TERRAFORM_DIR, "terraform.tfvars");
const WRANGLER_CONFIG = join(ROOT, "wrangler.jsonc");

const AUTO_ENV_KEYS = [
	"POLICY_AUD",
	"WORKER_URL",
	"DISCOVERY_URL",
	"AIG_AUTH_TOKEN_ID",
	"USER_DB_ID",
	"USER_DB_NAME",
	"CONFIG_CACHE_KV_ID",
];

const REQUIRED_ENV_KEYS = [
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_ACCOUNT_ID",
	"TEAM_DOMAIN",
	"CUSTOM_HOSTNAME",
	"CLOUDFLARE_ZONE_ID",
];

const DEFAULTS = {
	WORKER_NAME: "opencode-access",
	AIG_GATEWAY_ID: "opencode-access",
	AIG_LOG_PAYLOADS: "false",
	OPENCODE_PROVIDER_ID: "cloudflare-access-gateway",
	OPENCODE_PROVIDER_NAME: "Cloudflare Access Gateway",
};

const command = process.argv[2] ?? "up";

try {
	main(command);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

function main(commandName) {
	ensurePrerequisites();
	const env = loadEnvFile();

	if (commandName === "up") {
		validateRequiredEnv(env);
		const bundle = buildWorkerBundle();
		ensureAiGateway(env);
		writeTerraformTfvars(env, bundle);
		terraformInit();
		terraformApply(env);
		const outputs = readTerraformOutputs();
		applyRemoteMigrations(env, outputs);
		writeEnvUpdates({
			POLICY_AUD: outputs.policy_aud?.value,
			WORKER_URL: outputs.worker_url?.value,
			DISCOVERY_URL: outputs.discovery_url?.value,
			AIG_AUTH_TOKEN_ID: outputs.ai_gateway_token_id?.value,
			USER_DB_ID: outputs.user_db_id?.value,
			USER_DB_NAME: outputs.user_db_name?.value,
			CONFIG_CACHE_KV_ID: outputs.config_cache_kv_id?.value,
		});
		printSuccess(outputs);
		return;
	}

	if (commandName === "deploy") {
		validateRequiredEnv(env);
		requireExistingDeployment();
		const bundle = buildWorkerBundle();
		writeTerraformTfvars(env, bundle);
		terraformInit();
		terraformApply(env, ["-target=cloudflare_workers_script.opencode"]);
		const outputs = readTerraformOutputs();
		applyRemoteMigrations(env, outputs);
		printDeploySuccess(outputs);
		return;
	}

	if (commandName === "down") {
		validateRequiredEnv(env);
		const bundle = resolveExistingBundle();
		writeTerraformTfvars(env, bundle);
		terraformInit();
		terraformDestroy(env);
		deleteAiGateway(env);
		removeEnvKeys(AUTO_ENV_KEYS);
		console.log("Terraform-managed resources deleted.");
		return;
	}

	throw new Error(`Unknown command '${commandName}'. Use 'up', 'deploy', or 'down'.`);
}

function requireExistingDeployment() {
	if (!existsSync(join(TERRAFORM_DIR, "terraform.tfstate"))) {
		throw new Error("No existing Terraform state found. Run `npm run setup` first.");
	}
}

function ensurePrerequisites() {
	runQuiet("terraform", ["version"], "terraform is not installed or not in PATH.");
	runQuiet("node", ["--version"], "node is not installed or not in PATH.");
	runQuiet("npx", ["wrangler", "--version"], "wrangler is not available via npx.");
	if (!existsSync(TERRAFORM_DIR)) {
		mkdirSync(TERRAFORM_DIR, { recursive: true });
	}
}

function loadEnvFile() {
	if (!existsSync(ENV_FILE)) {
		if (!existsSync(ENV_EXAMPLE_FILE)) {
			throw new Error("Missing both .env and .env.example.");
		}
		writeFileSync(ENV_FILE, readFileSync(ENV_EXAMPLE_FILE, "utf8"), "utf8");
		throw new Error("Created .env from .env.example. Fill in the required values and run the command again.");
	}

	const env = { ...DEFAULTS };
	for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}
		const equalsIndex = trimmed.indexOf("=");
		if (equalsIndex === -1) {
			continue;
		}
		const key = trimmed.slice(0, equalsIndex).trim();
		const value = trimmed
			.slice(equalsIndex + 1)
			.trim()
			.replace(/^['"]|['"]$/g, "");
		env[key] = value;
		process.env[key] ??= value;
	}

	return env;
}

function validateRequiredEnv(env) {
	const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key]);
	if (missing.length > 0) {
		throw new Error(`Missing required .env values: ${missing.join(", ")}`);
	}

	let teamDomain;
	try {
		teamDomain = new URL(env.TEAM_DOMAIN);
	} catch {
		throw new Error("TEAM_DOMAIN must be a full URL such as https://your-team.cloudflareaccess.com");
	}

	if (teamDomain.protocol !== "https:") {
		throw new Error("TEAM_DOMAIN must use https.");
	}

	if (!teamDomain.hostname.endsWith(".cloudflareaccess.com")) {
		throw new Error("TEAM_DOMAIN must point at your Cloudflare Access team domain.");
	}

	if (!env.CUSTOM_HOSTNAME.includes(".") || env.CUSTOM_HOSTNAME.endsWith(".workers.dev")) {
		throw new Error("CUSTOM_HOSTNAME must be a custom hostname on a Cloudflare zone, not a workers.dev hostname.");
	}
	if (!/^[a-zA-Z0-9.-]+$/.test(env.CUSTOM_HOSTNAME)) {
		throw new Error("CUSTOM_HOSTNAME contains invalid characters.");
	}
	if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ZONE_ID)) {
		throw new Error("CLOUDFLARE_ZONE_ID must be a 32-character Cloudflare zone ID.");
	}
}

function buildWorkerBundle() {
	rmSync(DIST_DIR, { force: true, recursive: true });
	console.log("Bundling Worker with Wrangler...");
	execFileSync(
		"npx",
		["wrangler", "deploy", "--dry-run", "--outdir", DIST_DIR, "--config", WRANGLER_CONFIG],
		{ cwd: ROOT, stdio: "inherit" },
	);

	const bundle = findSingleJsBundle(DIST_DIR);
	return {
		name: basename(bundle),
		path: bundle,
	};
}

function resolveExistingBundle() {
	if (!existsSync(DIST_DIR)) {
		return buildWorkerBundle();
	}
	const bundle = findSingleJsBundle(DIST_DIR);
	return {
		name: basename(bundle),
		path: bundle,
	};
}

function findSingleJsBundle(directory) {
	const matches = [];
	visitDirectory(directory, matches);
	if (matches.length !== 1) {
		throw new Error(
			`Expected Wrangler dry-run to emit exactly one JavaScript bundle in ${directory}, found ${matches.length}.`,
		);
	}
	return matches[0];
}

function visitDirectory(directory, matches) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			visitDirectory(entryPath, matches);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".js.map")) {
			matches.push(entryPath);
		}
	}
}

function ensureAiGateway(env) {
	console.log("Ensuring AI Gateway exists...");
	const gatewayUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways/${env.AIG_GATEWAY_ID}`;
	const body = {
		authentication: true,
		cache_invalidate_on_update: true,
		cache_ttl: 0,
		collect_logs: true,
		rate_limiting_interval: 0,
		rate_limiting_limit: 0,
		workers_ai_billing_mode: "postpaid",
	};

	const existing = cloudflareApiRequest(env.CLOUDFLARE_API_TOKEN, gatewayUrl, {
		method: "GET",
		allowStatuses: [404],
	});

	if (existing.status === 404) {
		const createUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways`;
		const created = cloudflareApiRequest(env.CLOUDFLARE_API_TOKEN, createUrl, {
			method: "POST",
			body: JSON.stringify({ id: env.AIG_GATEWAY_ID, ...body }),
		});
		if (!created.success) {
			throw new Error(formatApiErrors("Failed to create AI Gateway", created.errors));
		}
		return;
	}

	if (!existing.success) {
		throw new Error(formatApiErrors("Failed to fetch AI Gateway", existing.errors));
	}

	const updated = cloudflareApiRequest(env.CLOUDFLARE_API_TOKEN, gatewayUrl, {
		method: "PUT",
		body: JSON.stringify(body),
	});
	if (!updated.success) {
		throw new Error(formatApiErrors("Failed to update AI Gateway", updated.errors));
	}
}

function deleteAiGateway(env) {
	console.log("Deleting AI Gateway...");
	const gatewayUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways/${env.AIG_GATEWAY_ID}`;
	const deleted = cloudflareApiRequest(env.CLOUDFLARE_API_TOKEN, gatewayUrl, {
		method: "DELETE",
		allowStatuses: [404],
	});
	if (deleted.status === 404) {
		return;
	}
	if (!deleted.success) {
		throw new Error(formatApiErrors("Failed to delete AI Gateway", deleted.errors));
	}
}

function writeTerraformTfvars(env, bundle) {
	const tfvars = {
		cloudflare_account_id: env.CLOUDFLARE_ACCOUNT_ID,
		team_domain: env.TEAM_DOMAIN,
		custom_hostname: env.CUSTOM_HOSTNAME,
		cloudflare_zone_id: env.CLOUDFLARE_ZONE_ID,
		worker_name: env.WORKER_NAME,
		aig_gateway_id: env.AIG_GATEWAY_ID,
		aig_log_payloads: env.AIG_LOG_PAYLOADS,
		opencode_provider_id: env.OPENCODE_PROVIDER_ID,
		opencode_provider_name: env.OPENCODE_PROVIDER_NAME,
		worker_bundle_name: bundle.name,
		worker_bundle_path: bundle.path,
	};

	const lines = Object.entries(tfvars).map(([key, value]) => `${key} = ${toTerraformLiteral(value)}`);
	writeFileSync(TERRAFORM_TFVARS_FILE, `${lines.join("\n")}\n`, "utf8");
	console.log("Wrote terraform/terraform.tfvars");
}

function applyRemoteMigrations(env, outputs) {
	const migrationConfigPath = createMigrationWranglerConfig(outputs);
	const migrations = getMigrationFiles();

	if (migrations.length === 0) {
		console.log("No D1 migrations found.");
		rmSync(migrationConfigPath, { force: true });
		return;
	}

	try {
		for (const migration of migrations) {
			console.log(`Applying D1 migration ${migration}...`);
			execFileSync(
				"npx",
				[
					"wrangler",
					"d1",
					"execute",
					"USER_DB",
					"--remote",
					"--yes",
					"--file",
					join(MIGRATIONS_DIR, migration),
					"--config",
					migrationConfigPath,
				],
				{
					cwd: ROOT,
					stdio: "inherit",
					env: {
						...process.env,
						CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
						CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
					},
				},
			);
		}
	} finally {
		rmSync(migrationConfigPath, { force: true });
	}
}

function createMigrationWranglerConfig(outputs) {
	const userDbId = outputs.user_db_id?.value;
	const userDbName = outputs.user_db_name?.value;
	const configCacheKvId = outputs.config_cache_kv_id?.value;

	if (!userDbId || !userDbName || !configCacheKvId) {
		throw new Error(
			"Terraform apply completed, but expected KV/D1 outputs were missing for migrations.",
		);
	}

	const tempDir = join(ROOT, ".wrangler");
	mkdirSync(tempDir, { recursive: true });
	const migrationConfigPath = join(tempDir, "wrangler.migrations.jsonc");

	let config = readFileSync(WRANGLER_CONFIG, "utf8");
	config = config.replace(
		/("binding":\s*"CONFIG_CACHE",\s*"id":\s*")([^"]+)(")/,
		`$1${configCacheKvId}$3`,
	);
	config = config.replace(
		/("binding":\s*"USER_DB",\s*"database_name":\s*")([^"]+)(",\s*"database_id":\s*")([^"]+)(")/,
		`$1${userDbName}$3${userDbId}$5`,
	);
	writeFileSync(migrationConfigPath, config, "utf8");
	return migrationConfigPath;
}

function getMigrationFiles() {
	if (!existsSync(MIGRATIONS_DIR)) {
		return [];
	}

	return readdirSync(MIGRATIONS_DIR)
		.filter((entry) => entry.endsWith(".sql"))
		.sort();
}

function toTerraformLiteral(value) {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => toTerraformLiteral(entry)).join(", ")}]`;
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	if (typeof value === "number") {
		return String(value);
	}
	return JSON.stringify(value ?? "");
}

function terraformInit() {
	console.log("Running terraform init...");
	execFileSync("terraform", ["init", "-input=false"], {
		cwd: TERRAFORM_DIR,
		stdio: "inherit",
	});
}

function terraformApply(env, extraArgs = []) {
	console.log("Running terraform apply...");
	execFileSync("terraform", ["apply", "-auto-approve", "-input=false", ...extraArgs], {
		cwd: TERRAFORM_DIR,
		stdio: "inherit",
		env: {
			...process.env,
			TF_VAR_cloudflare_api_token: env.CLOUDFLARE_API_TOKEN,
		},
	});
}

function terraformDestroy(env) {
	console.log("Running terraform destroy...");
	execFileSync("terraform", ["destroy", "-auto-approve", "-input=false"], {
		cwd: TERRAFORM_DIR,
		stdio: "inherit",
		env: {
			...process.env,
			TF_VAR_cloudflare_api_token: env.CLOUDFLARE_API_TOKEN,
		},
	});
}

function readTerraformOutputs() {
	const output = execFileSync("terraform", ["output", "-json"], {
		cwd: TERRAFORM_DIR,
		encoding: "utf8",
	});
	return JSON.parse(output);
}

function writeEnvUpdates(updates) {
	let envContent = readFileSync(ENV_FILE, "utf8");
	for (const [key, rawValue] of Object.entries(updates)) {
		if (!rawValue) {
			continue;
		}
		const value = String(rawValue);
		const pattern = new RegExp(`^(#\\s*)?${escapeRegExp(key)}=.*$`, "m");
		const replacement = `${key}=${value}`;
		if (pattern.test(envContent)) {
			envContent = envContent.replace(pattern, replacement);
		} else {
			envContent += `\n${replacement}\n`;
		}
	}
	writeFileSync(ENV_FILE, envContent, "utf8");
}

function removeEnvKeys(keys) {
	let envContent = readFileSync(ENV_FILE, "utf8");
	for (const key of keys) {
		const pattern = new RegExp(`^(#\\s*)?${escapeRegExp(key)}=.*(?:\r?\n)?`, "gm");
		envContent = envContent.replace(pattern, "");
	}
	writeFileSync(ENV_FILE, envContent.trimEnd() + "\n", "utf8");
}

function printSuccess(outputs) {
	const workerUrl = outputs.worker_url?.value;
	const discoveryUrl = outputs.discovery_url?.value;
	if (!workerUrl || !discoveryUrl) {
		throw new Error("Terraform apply completed, but expected outputs were missing.");
	}

	console.log("\nDeployment complete.");
	console.log(`Worker URL: ${workerUrl}`);
	console.log(`Discovery URL: ${discoveryUrl}`);
	console.log(`OpenCode login: opencode auth login ${workerUrl}`);
	console.log("\nNext steps:");
	console.log("- Configure or tighten your Cloudflare Access IdP and policy in Zero Trust if you do not want the default broad allow policy.");
	console.log("- Configure AI Gateway providers, Unified Billing, or BYOK in the Cloudflare dashboard.");
}

function printDeploySuccess(outputs) {
	const workerUrl = outputs.worker_url?.value;
	if (!workerUrl) {
		throw new Error("Terraform deploy completed, but worker_url output was missing.");
	}

	console.log("\nWorker updated.");
	console.log(`Worker URL: ${workerUrl}`);
	console.log("Use `npm run setup` when you need to reconcile infrastructure or refresh generated .env values.");
}

function runQuiet(command, args, errorMessage) {
	try {
		execFileSync(command, args, { cwd: ROOT, stdio: "ignore" });
	} catch {
		throw new Error(errorMessage);
	}
}

function cloudflareApiRequest(apiToken, url, options = {}) {
	const { allowStatuses = [], ...requestOptions } = options;
	const response = fetchSync(url, {
		...requestOptions,
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Content-Type": "application/json",
			...(requestOptions.headers ?? {}),
		},
	});

	if (!response.ok && !allowStatuses.includes(response.status)) {
		throw new Error(`Cloudflare API request failed (${response.status} ${response.statusText}) for ${url}`);
	}

	const parsedBody = response.body ? JSON.parse(response.body) : {};
	return {
		status: response.status,
		...parsedBody,
	};
}

function fetchSync(url, options) {
	const fetchResult = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const response = await fetch(${JSON.stringify(url)}, ${JSON.stringify(options)}); const body = await response.text(); process.stdout.write(JSON.stringify({ ok: response.ok, status: response.status, statusText: response.statusText, body }));`,
		],
		{ cwd: ROOT, encoding: "utf8" },
	);
	return JSON.parse(fetchResult);
}

function formatApiErrors(prefix, errors) {
	const details = Array.isArray(errors) && errors.length > 0
		? errors.map((error) => error.message).join("; ")
		: "Unknown API error";
	return `${prefix}: ${details}`;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
