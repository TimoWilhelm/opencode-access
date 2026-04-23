import type { CatalogEntry } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function parseChatCompletionPayload(
	request: Request,
): Promise<Record<string, unknown> | null> {
	try {
		const payload: unknown = await request.json();
		if (!isRecord(payload)) {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}

export function getRequestedModel(payload: Record<string, unknown>): string | undefined {
	return typeof payload.model === "string" ? payload.model : undefined;
}

export function getCanonicalModelId(
	requestedModel: string,
	models: CatalogEntry[],
): string | undefined {
	for (const model of models) {
		if (requestedModel === model.id || requestedModel === model.exposedId) {
			return model.id;
		}
	}

	return undefined;
}

export async function proxyChatCompletions(
	requestHeaders: Headers,
	env: Env,
	userId: string,
	payload: Record<string, unknown>,
): Promise<Response> {
	return fetch(getAiGatewayCompatUrl(env, "/chat/completions"), {
		method: "POST",
		headers: buildProxyHeaders(requestHeaders, env, userId),
		body: JSON.stringify(payload),
	});
}

function buildProxyHeaders(
	requestHeaders: Headers,
	env: Env,
	userId: string,
): Headers {
	const headers = new Headers(requestHeaders);
	const strippedHeaders = [
		"authorization",
		"cookie",
		"cf-access-token",
		"cf-access-jwt-assertion",
		"cf-access-client-id",
		"cf-access-client-secret",
		"cf-access-authenticated-user-email",
		"cf-connecting-ip",
		"x-forwarded-for",
		"x-real-ip",
		"host",
		"cf-aig-authorization",
		"cf-aig-metadata",
		"content-length",
	];

	for (const header of strippedHeaders) {
		headers.delete(header);
	}

	headers.set("cf-aig-authorization", `Bearer ${env.AIG_AUTH_TOKEN}`);
	headers.set(
		"cf-aig-metadata",
		JSON.stringify({
			userId,
			authType: "cloudflare-access",
		}),
	);
	headers.set(
		"cf-aig-collect-log-payload",
		String(env.AIG_LOG_PAYLOADS) === "true" ? "true" : "false",
	);
	headers.set("content-type", headers.get("content-type") ?? "application/json");

	return headers;
}

function getAiGatewayCompatUrl(env: Env, pathname: string): string {
	return `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/compat${pathname}`;
}
