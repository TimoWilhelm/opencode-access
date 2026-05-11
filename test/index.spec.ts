import {
	env as bindings,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/app";

type DiscoveryEnvelope = {
	auth: { command: string[]; env: string };
	config: {
		enabled_providers: string[];
		model?: string;
		small_model?: string;
		provider: Record<
			string,
			{
				options: {
					baseURL: string;
					apiKey: string;
					headers?: Record<string, string>;
				};
				models: Record<string, { id?: string; limit?: { context: number; output: number } }>;
			}
		>;
	};
};

type GatewayMetadata = {
	userId: string;
	authType?: string;
};

const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DiscoveryModelsEnvelope = {
	config: {
		enabled_providers: string[];
		provider: Record<string, { models: Record<string, unknown> }>;
	};
};

let accessPrivateKey: CryptoKey;
let jwksPayload = "";

beforeAll(async () => {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	accessPrivateKey = privateKey;
	const publicJwk = await exportJWK(publicKey);
	jwksPayload = JSON.stringify({
		keys: [
			{
				...publicJwk,
				kid: "test-access-key",
				alg: "RS256",
				use: "sig",
			},
		],
	});

	await bindings.USER_DB.prepare(
		"CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, anonymous_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)",
	).run();
	await bindings.USER_DB.prepare(
		"CREATE INDEX IF NOT EXISTS idx_users_anonymous_id ON users(anonymous_id)",
	).run();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("opencode access gateway worker", () => {
	it("serves the landing page from the assets binding", async () => {
		const env = createTestEnv();
		const ctx = createExecutionContext();

		const response = await worker.fetch(new Request("https://gateway.example.com/"), env, ctx);

		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("Authorization Successful");
	});

	it("serves a public OpenCode discovery envelope", async () => {
		const env = createTestEnv();
		const ctx = createExecutionContext();

		const response = await worker.fetch(
			new Request("https://gateway.example.com/.well-known/opencode"),
			env,
			ctx,
		);

		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const payload: DiscoveryEnvelope = await response.json();

		expect(payload.auth.env).toBe("OPENCODE_ACCESS_TOKEN");
		expect(payload.auth.command).toEqual([
			"cloudflared",
			"access",
			"login",
			"--no-verbose",
			"-app=https://gateway.example.com",
		]);
		expect(payload.config.enabled_providers).toEqual(["cloudflare-access-gateway"]);
		expect(payload.config.model).toBe(
			"cloudflare-access-gateway/@cf/moonshotai/kimi-k2.6",
		);
		expect(payload.config.small_model).toBe(
			"cloudflare-access-gateway/@cf/google/gemma-4-26b-a4b-it",
		);
		expect(
			payload.config.provider["cloudflare-access-gateway"].options.baseURL,
		).toBe("https://gateway.example.com/v1");
		expect(
			payload.config.provider["cloudflare-access-gateway"].options.apiKey,
		).toBe("");
		expect(
			payload.config.provider["cloudflare-access-gateway"].options.headers?.[
				"cf-access-token"
			],
		).toBe("{env:OPENCODE_ACCESS_TOKEN}");
		expect(
			payload.config.provider["cloudflare-access-gateway"].options.headers?.[
				"X-Requested-With"
			],
		).toBe("xmlhttprequest");
		expect(
			payload.config.provider["cloudflare-access-gateway"].models[
				"@cf/moonshotai/kimi-k2.6"
			],
		).toBeDefined();
		expect(
			payload.config.provider["cloudflare-access-gateway"].models[
				"claude-4-7-opus"
			],
		).toBeDefined();
		expect(
			payload.config.provider["cloudflare-access-gateway"].models["claude-4-7-opus"].id,
		).toBe("anthropic/claude-4-7-opus");
		expect(
			payload.config.provider["cloudflare-access-gateway"].models["claude-4-7-opus"].limit,
		).toEqual({
			context: 1_000_000,
			output: 128_000,
		});
		expect(
			payload.config.provider["cloudflare-access-gateway"].models[
				"@cf/moonshotai/kimi-k2.6"
			].limit,
		).toBeUndefined();
		expect(
			payload.config.provider["cloudflare-access-gateway"].models[
				"@cf/google/gemma-4-26b-a4b-it"
			].limit,
		).toBeUndefined();
	});

	it("rejects proxy requests without a Cloudflare Access token", async () => {
		const env = createTestEnv();
		const ctx = createExecutionContext();

		const response = await worker.fetch(
			new Request("https://gateway.example.com/v1/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "anthropic/claude-4-7-opus",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
			env,
			ctx,
		);

		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: {
				message: "Missing Cloudflare Access token",
			},
		});
	});

	it("proxies authenticated requests to AI Gateway with Access user metadata", async () => {
		const env = createTestEnv();
		const email = `developer-${crypto.randomUUID()}@example.com`;
		const token = await issueAccessToken({ email });
		const requests: Array<{ headers: Headers; body: string }> = [];

		stubPlatformFetch({
			jwksUrl: `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
			upstreamUrl: `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/compat/chat/completions`,
			upstreamHandler: async (request) => {
				requests.push({ headers: new Headers(request.headers), body: await request.text() });
				return new Response(
					JSON.stringify({
						id: "chatcmpl-test",
						object: "chat.completion",
						choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
					}),
					{
						headers: {
							"content-type": "application/json",
						},
					},
				);
			},
		});

		const firstResponse = await callWorker(
			env,
			new Request("https://gateway.example.com/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "anthropic/claude-4-7-opus",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
		);

		expect(firstResponse.status).toBe(200);
		expect(requests).toHaveLength(1);
		expect(requests[0].headers.get("authorization")).toBeNull();
		expect(requests[0].headers.get("cookie")).toBeNull();
		expect(requests[0].headers.get("host")).toBeNull();
		expect(requests[0].headers.get("cf-aig-authorization")).toBe(
			"Bearer set-via-wrangler-secret",
		);
		expect(requests[0].headers.get("cf-aig-collect-log-payload")).toBe("false");

		const firstMetadata: GatewayMetadata = JSON.parse(
			requests[0].headers.get("cf-aig-metadata") ?? "{}",
		);
		expect(firstMetadata.authType).toBe("cloudflare-access");
		expect(firstMetadata.userId).toMatch(UUID_V4_PATTERN);
		expect(firstMetadata.userId).not.toBe("user-123");
		expect(firstMetadata.userId).not.toBe(email);
		expect(Object.hasOwn(firstMetadata, "username")).toBe(false);

		const storedUser = await env.USER_DB.prepare(
			"SELECT email, anonymous_id FROM users WHERE email = ?",
		)
			.bind(email)
			.first<{ email: string; anonymous_id: string }>();
		expect(storedUser).toEqual({
			email,
			anonymous_id: firstMetadata.userId,
		});
		expect(await env.CONFIG_CACHE.get(`user:${email}`)).toBe(firstMetadata.userId);

		const secondResponse = await callWorker(
			env,
			new Request("https://gateway.example.com/v1/chat/completions", {
				method: "POST",
				headers: {
					"cf-access-token": token,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "anthropic/claude-4-7-opus",
					messages: [{ role: "user", content: "hello again" }],
				}),
			}),
		);

		expect(secondResponse.status).toBe(200);
		expect(requests).toHaveLength(2);
		const secondMetadata: GatewayMetadata = JSON.parse(
			requests[1].headers.get("cf-aig-metadata") ?? "{}",
		);
		expect(secondMetadata.userId).toBe(firstMetadata.userId);
	});

	it("proxies authenticated websocket upgrades to AI Gateway with allowlisted models", async () => {
		const env = createTestEnv();
		const email = `developer-${crypto.randomUUID()}@example.com`;
		const token = await issueAccessToken({ email });
		const requests: Array<{ headers: Headers }> = [];
		const upstreamUrl = new URL(
			`https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/compat/responses`,
		);
		upstreamUrl.searchParams.set("model", "anthropic/claude-4-7-opus");

		stubPlatformFetch({
			jwksUrl: `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
			upstreamUrl: upstreamUrl.href,
			upstreamHandler: async (request) => {
				requests.push({ headers: new Headers(request.headers) });
				return createWebSocketUpgradeResponse();
			},
		});

		const response = await callWorker(
			env,
			new Request("https://gateway.example.com/v1/responses?model=claude-4-7-opus", {
				method: "GET",
				headers: {
					authorization: `Bearer ${token}`,
					upgrade: "websocket",
					connection: "Upgrade",
					host: "gateway.example.com",
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(requests).toHaveLength(1);
		expect(requests[0].headers.get("upgrade")).toBe("websocket");
		expect(requests[0].headers.get("authorization")).toBeNull();
		expect(requests[0].headers.get("host")).toBeNull();
		expect(requests[0].headers.get("cf-aig-authorization")).toBe(
			"Bearer set-via-wrangler-secret",
		);

		const metadata: GatewayMetadata = JSON.parse(
			requests[0].headers.get("cf-aig-metadata") ?? "{}",
		);
		expect(metadata.authType).toBe("cloudflare-access");
		expect(metadata.userId).toMatch(UUID_V4_PATTERN);
	});

	it("rejects websocket upgrades without a model query parameter", async () => {
		const env = createTestEnv();
		const token = await issueAccessToken();

		stubPlatformFetch({
			jwksUrl: `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
		});

		const response = await callWorker(
			env,
			new Request("https://gateway.example.com/v1/responses", {
				method: "GET",
				headers: {
					authorization: `Bearer ${token}`,
					upgrade: "websocket",
					connection: "Upgrade",
				},
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				message: "A model query parameter must be provided",
			},
		});
	});

	it("returns 502 when AI Gateway does not complete the websocket upgrade", async () => {
		const env = createTestEnv();
		const token = await issueAccessToken();
		const upstreamUrl = new URL(
			`https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/compat/responses`,
		);
		upstreamUrl.searchParams.set("model", "anthropic/claude-4-7-opus");

		stubPlatformFetch({
			jwksUrl: `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
			upstreamUrl: upstreamUrl.href,
			upstreamHandler: async () => new Response("upgrade failed", { status: 500 }),
		});

		const response = await callWorker(
			env,
			new Request("https://gateway.example.com/v1/responses?model=claude-4-7-opus", {
				method: "GET",
				headers: {
					authorization: `Bearer ${token}`,
					upgrade: "websocket",
					connection: "Upgrade",
				},
			}),
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: {
				message: "AI Gateway did not complete the WebSocket upgrade",
			},
		});
	});

	it("rejects Access tokens that do not include an email claim", async () => {
		const env = createTestEnv();
		const token = await issueAccessToken({ email: undefined });

		stubPlatformFetch({
			jwksUrl: `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
		});

		const response = await callWorker(
			env,
			new Request("https://gateway.example.com/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "anthropic/claude-4-7-opus",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: {
				message: "Cloudflare Access token is missing an email claim",
			},
		});
	});

	it("blocks models outside the configured allowlist", async () => {
		const env = createTestEnv();
		const token = await issueAccessToken();

		stubPlatformFetch({
			jwksUrl: `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
			upstreamUrl: `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/compat/chat/completions`,
		});

		const response = await callWorker(
			env,
			new Request("https://gateway.example.com/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "openai/gpt-5.2-mini",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: {
				message: "Model 'openai/gpt-5.2-mini' is not allowed by this gateway",
			},
		});
	});

	it("returns 400 when the chat completion payload is not valid JSON", async () => {
		const env = createTestEnv();
		const token = await issueAccessToken();

		stubPlatformFetch({
			jwksUrl: `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
			upstreamUrl: `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/compat/chat/completions`,
		});

		const response = await callWorker(
			env,
			new Request("https://gateway.example.com/v1/chat/completions", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: "{not-json}",
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				message: "Request body must be valid JSON",
			},
		});
	});

	it("derives the model map directly from config/opencode.json", async () => {
		const env = createTestEnv();
		const response = await callWorker(
			env,
			new Request("https://gateway.example.com/.well-known/opencode"),
		);
		const payload: DiscoveryModelsEnvelope = await response.json();

		expect(response.status).toBe(200);
		expect(payload.config.enabled_providers).toEqual(["cloudflare-access-gateway"]);
		expect(
			Object.keys(payload.config.provider["cloudflare-access-gateway"].models).sort(),
		).toEqual([
			"@cf/google/gemma-4-26b-a4b-it",
			"@cf/moonshotai/kimi-k2.6",
			"claude-4-7-opus",
		]);
	});
});

function createTestEnv(overrides: Partial<Env> = {}): Env {
	return {
		...bindings,
		ASSETS: bindings.ASSETS || createAssetsBinding(),
		CONFIG_CACHE: bindings.CONFIG_CACHE,
		USER_DB: bindings.USER_DB,
		TEAM_DOMAIN: bindings.TEAM_DOMAIN || "https://your-team.cloudflareaccess.com",
		POLICY_AUD: bindings.POLICY_AUD || "test-policy-aud",
		CLOUDFLARE_ACCOUNT_ID: bindings.CLOUDFLARE_ACCOUNT_ID || "test-account-id",
		AIG_GATEWAY_ID: "opencode-access",
		AIG_AUTH_TOKEN: "set-via-wrangler-secret",
		AIG_LOG_PAYLOADS: "false",
		OPENCODE_PROVIDER_ID: "cloudflare-access-gateway",
		OPENCODE_PROVIDER_NAME: "Cloudflare Access Gateway",
		...overrides,
	};
}

function createAssetsBinding(): Fetcher {
	return {
		fetch: async () =>
			new Response("<!doctype html><html><body>Authorization Successful</body></html>", {
				headers: {
					"content-type": "text/html; charset=utf-8",
				},
			}),
	} as Fetcher;
}

async function issueAccessToken(
	claims: { email?: string; commonName?: string; subject?: string } = {},
): Promise<string> {
	const payload: Record<string, string> = {
		common_name: claims.commonName ?? "Developer Example",
	};

	if (Object.hasOwn(claims, "email")) {
		if (claims.email !== undefined) {
			payload.email = claims.email;
		}
	} else {
		payload.email = "developer@example.com";
	}

	return new SignJWT(payload)
		.setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
		.setIssuer(bindings.TEAM_DOMAIN)
		.setAudience(bindings.POLICY_AUD)
		.setSubject(claims.subject ?? "user-123")
		.setIssuedAt()
		.setExpirationTime("2h")
		.sign(accessPrivateKey);
}

async function callWorker(env: Env, request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function stubPlatformFetch(options: {
	jwksUrl?: string;
	upstreamUrl?: string;
	upstreamHandler?: (request: Request) => Promise<Response>;
}): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = input instanceof Request ? input : new Request(input, init);
			const url = new URL(request.url);

			if (options.jwksUrl && request.url === options.jwksUrl) {
				return new Response(jwksPayload, {
					headers: {
						"content-type": "application/json",
					},
				});
			}

			if (options.upstreamUrl && url.href === options.upstreamUrl) {
				if (options.upstreamHandler) {
					return options.upstreamHandler(request);
				}

				throw new Error("Unexpected AI Gateway request");
			}

			throw new Error(`Unexpected fetch to ${request.url}`);
		}),
	);
}

function createWebSocketUpgradeResponse(): Response {
	const response = new Response(null, {
		status: 200,
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
		},
	});

	Object.defineProperty(response, "webSocket", {
		value: {},
		configurable: true,
	});

	return response;
}
