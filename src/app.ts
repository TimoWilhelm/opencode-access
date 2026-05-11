import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { extractAccessToken, getAccessUserMetadata, verifyAccessToken } from "./access";
import {
	getCanonicalModelId,
	getRequestedModel,
	getRequestedWebSocketModel,
	isWebSocketUpgradeRequest,
	parseChatCompletionPayload,
	proxyChatCompletions,
	proxyWebSocketResponses,
} from "./ai-gateway";
import { loadCatalog } from "./catalog";
import { buildDiscoveryEnvelope, buildModelsResponse } from "./discovery";
import type { AppBindings } from "./types";
import { getOrCreateAnonymousUserId } from "./users";

export const app = new Hono<AppBindings>();

app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return error.getResponse();
	}

	console.error(
		JSON.stringify({
			message: "Unhandled application error",
			path: new URL(c.req.url).pathname,
			error: error instanceof Error ? error.message : String(error),
		}),
	);

	return jsonError(c, 500, "Internal server error");
});

app.notFound((c) => jsonError(c, 404, "Not found"));

app.use("/v1/*", async (c, next) => {
	const token = extractAccessToken(c.req.raw.headers);
	if (!token) {
		return jsonError(c, 401, "Missing Cloudflare Access token");
	}

	try {
		const payload = await verifyAccessToken(token, c.env);
		const accessUser = getAccessUserMetadata(payload);
		if (!accessUser) {
			return jsonError(c, 403, "Cloudflare Access token is missing an email claim");
		}

		const anonymousUserId = await getOrCreateAnonymousUserId(
			c.env.CONFIG_CACHE,
			c.env.USER_DB,
			accessUser.email,
		);

		c.set("anonymousUserId", anonymousUserId);
	} catch (error) {
		if (!(error instanceof Error) || !/JWT|JWS|JWKS|token|signature|claim|audience|issuer/i.test(error.message)) {
			throw error;
		}

		return jsonError(
			c,
			401,
			error instanceof Error ? error.message : "Invalid Cloudflare Access token",
		);
	}

	await next();
});

app.get("/healthz", async (c) => {
	const catalog = loadCatalog(c.env);
	return c.json({
		ok: true,
		providerId: c.env.OPENCODE_PROVIDER_ID,
		catalogSource: catalog.source,
		catalogSyncedAt: catalog.syncedAt,
		modelCount: catalog.models.length,
	});
});

app.get("/.well-known/opencode", async (c) => {
	const catalog = loadCatalog(c.env);
	const origin = new URL(c.req.url).origin;
	return c.json(buildDiscoveryEnvelope(origin, c.env, catalog));
});

app.get("/", (c) => c.env.ASSETS.fetch(c.req.raw));

app.get("/v1/models", async (c) => {
	const catalog = loadCatalog(c.env);
	return c.json(buildModelsResponse(c.env, catalog));
});

app.get("/v1/responses", async (c) => {
	if (!isWebSocketUpgradeRequest(c.req.raw)) {
		return jsonError(c, 404, "Not found");
	}

	const model = getRequestedWebSocketModel(c.req.raw);
	if (!model) {
		return jsonError(c, 400, "A model query parameter must be provided");
	}

	const catalog = loadCatalog(c.env);
	const canonicalModel = getCanonicalModelId(model, catalog.models);
	if (!canonicalModel) {
		return jsonError(c, 403, `Model '${model}' is not allowed by this gateway`);
	}

	const proxyResponse = await proxyWebSocketResponses(
		c.req.raw,
		c.env,
		c.get("anonymousUserId"),
		canonicalModel,
	);

	if (!proxyResponse.webSocket) {
		console.error(
			JSON.stringify({
				message: "AI Gateway did not complete the WebSocket upgrade",
				path: new URL(c.req.url).pathname,
				status: proxyResponse.status,
			}),
		);

		return jsonError(c, 502, "AI Gateway did not complete the WebSocket upgrade");
	}

	return proxyResponse;
});

app.post("/v1/chat/completions", async (c) => {
	const payload = await parseChatCompletionPayload(c.req.raw);
	if (!payload) {
		return jsonError(c, 400, "Request body must be valid JSON");
	}

	const model = getRequestedModel(payload);
	if (!model) {
		return jsonError(c, 400, "A model must be provided");
	}

	const catalog = loadCatalog(c.env);
	const canonicalModel = getCanonicalModelId(model, catalog.models);
	if (!canonicalModel) {
		return jsonError(c, 403, `Model '${model}' is not allowed by this gateway`);
	}
	payload.model = canonicalModel;

	return proxyChatCompletions(
		c.req.raw.headers,
		c.env,
		c.get("anonymousUserId"),
		payload,
	);
});

function jsonError(
	c: Context<AppBindings>,
	status: ContentfulStatusCode,
	message: string,
) {
	return c.json(
		{
			error: {
				message,
			},
		},
		status,
	);
}

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
