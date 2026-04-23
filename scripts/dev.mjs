#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ENV_FILE = join(ROOT, ".env");
const ENV_EXAMPLE_FILE = join(ROOT, ".env.example");
const DEV_VARS_FILE = join(ROOT, ".dev.vars");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const WRANGLER_CONFIG = join(ROOT, "wrangler.jsonc");

const DEFAULTS = {
	AIG_GATEWAY_ID: "opencode-access",
	AIG_LOG_PAYLOADS: "false",
	OPENCODE_PROVIDER_ID: "cloudflare-access-gateway",
	OPENCODE_PROVIDER_NAME: "Cloudflare Access Gateway",
};

const DEV_BINDINGS = [
	"TEAM_DOMAIN",
	"POLICY_AUD",
	"CLOUDFLARE_ACCOUNT_ID",
	"AIG_GATEWAY_ID",
	"AIG_AUTH_TOKEN",
	"AIG_LOG_PAYLOADS",
	"OPENCODE_PROVIDER_ID",
	"OPENCODE_PROVIDER_NAME",
];

try {
	const env = loadEnvFile();
	writeDevVars(env);
	applyLocalMigrations();
	execFileSync("npx", ["wrangler", "dev"], { cwd: ROOT, stdio: "inherit" });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

function loadEnvFile() {
	if (!existsSync(ENV_FILE)) {
		if (!existsSync(ENV_EXAMPLE_FILE)) {
			throw new Error("Missing both .env and .env.example.");
		}
		writeFileSync(ENV_FILE, readFileSync(ENV_EXAMPLE_FILE, "utf8"), "utf8");
		throw new Error("Created .env from .env.example. Fill in the values you need for local dev and run again.");
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
	}

	return env;
}

function writeDevVars(env) {
	const lines = DEV_BINDINGS.map((key) => `${key}=${JSON.stringify(env[key] ?? "")}`);
	writeFileSync(DEV_VARS_FILE, `${lines.join("\n")}\n`, "utf8");
	console.log("Generated .dev.vars from .env");
	if (!env.AIG_AUTH_TOKEN) {
		console.log("Warning: AIG_AUTH_TOKEN is empty in .env, so AI Gateway calls will fail until you set one for local dev.");
	}
	if (!env.POLICY_AUD) {
		console.log("Warning: POLICY_AUD is empty in .env, so local /v1 requests will reject Access tokens until you set it or run npm run setup.");
	}
	if (!env.TEAM_DOMAIN) {
		console.log("Warning: TEAM_DOMAIN is empty in .env, so Access verification will not work locally until you set it.");
	}
}

function applyLocalMigrations() {
	const migrations = getMigrationFiles();
	if (migrations.length === 0) {
		return;
	}

	for (const migration of migrations) {
		console.log(`Applying local D1 migration ${migration}...`);
		execFileSync(
			"npx",
			[
				"wrangler",
				"d1",
				"execute",
				"USER_DB",
				"--local",
				"--file",
				join(MIGRATIONS_DIR, migration),
				"--config",
				WRANGLER_CONFIG,
			],
			{ cwd: ROOT, stdio: "inherit" },
		);
	}
}

function getMigrationFiles() {
	if (!existsSync(MIGRATIONS_DIR)) {
		return [];
	}

	return readdirSync(MIGRATIONS_DIR)
		.filter((entry) => entry.endsWith(".sql"))
		.sort();
}
