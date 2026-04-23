import { getOpencodeConfigTemplate } from "./catalog";
import type { CatalogEntry, StoredCatalog } from "./types";

const DISCOVERY_AUTH_ENV = "OPENCODE_ACCESS_TOKEN";

export function buildDiscoveryEnvelope(origin: string, env: Env, catalog: StoredCatalog) {
	const providerId = env.OPENCODE_PROVIDER_ID || "cloudflare-access-gateway";
	const providerName = env.OPENCODE_PROVIDER_NAME || "Cloudflare Access Gateway";

	const config = renderConfig(getOpencodeConfigTemplate(), {
		providerId,
		providerName,
		baseURL: origin,
		envName: DISCOVERY_AUTH_ENV,
	});

	reconcileConfigWithCatalog(config, providerId, catalog);

	return {
		auth: {
			command: ["cloudflared", "access", "login", "--no-verbose", `-app=${origin}`],
			env: DISCOVERY_AUTH_ENV,
		},
		config,
	};
}

export function buildModelsResponse(env: Env, catalog: StoredCatalog) {
	return {
		object: "list",
		data: catalog.models.map((model) => ({
			id: model.exposedId,
			object: "model",
			created: 0,
			owned_by: model.id.split("/")[0] ?? env.OPENCODE_PROVIDER_ID,
			name: model.name,
		})),
	};
}

export function getExposedModelId(canonicalId: string, models: CatalogEntry[]): string {
	const match = models.find((model) => model.id === canonicalId);
	if (match) {
		return match.exposedId;
	}

	const slashIndex = canonicalId.indexOf("/");
	return slashIndex === -1 ? canonicalId : canonicalId.slice(slashIndex + 1);
}

type ConfigRoot = {
	provider?: Record<string, ProviderBlock>;
	[key: string]: unknown;
};

type ProviderBlock = {
	models?: Record<string, ModelEntry>;
	[key: string]: unknown;
};

type ModelEntry = {
	id?: string;
	name?: string;
	limit?: { context?: number; output?: number };
	[key: string]: unknown;
};

type RenderContext = {
	providerId: string;
	providerName: string;
	baseURL: string;
	envName: string;
};

function renderConfig(template: unknown, ctx: RenderContext): ConfigRoot {
	const substituted = JSON.stringify(template)
		.replaceAll("{providerId}", ctx.providerId)
		.replaceAll("{providerName}", ctx.providerName)
		.replaceAll("{baseURL}", ctx.baseURL)
		.replaceAll("{ENV_NAME}", ctx.envName);

	return JSON.parse(substituted) as ConfigRoot;
}

function reconcileConfigWithCatalog(
	config: ConfigRoot,
	providerId: string,
	catalog: StoredCatalog,
): void {
	const providerBlock = config.provider?.[providerId];
	if (!providerBlock) {
		return;
	}

	const exposedIds = new Set(catalog.models.map((model) => model.exposedId));
	const models = providerBlock.models ?? {};
	for (const exposedId of Object.keys(models)) {
		if (!exposedIds.has(exposedId)) {
			delete models[exposedId];
		}
	}

	for (const model of catalog.models) {
		const entry = models[model.exposedId];
		if (!entry) {
			continue;
		}
		if (entry.limit && !(entry.limit.context && entry.limit.output)) {
			delete entry.limit;
		}
	}

	providerBlock.models = models;
}
