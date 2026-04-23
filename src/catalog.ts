import opencodeConfig from "../config/opencode.json";
import type { CatalogEntry, StoredCatalog } from "./types";

const PROVIDER_PLACEHOLDER = "{providerId}";

export function loadCatalog(_env: Env): StoredCatalog {
	return {
		models: extractModels(opencodeConfig),
		source: "bundled-config",
		syncedAt: new Date(0).toISOString(),
	};
}

export function getOpencodeConfigTemplate(): unknown {
	return opencodeConfig;
}

function extractModels(config: typeof opencodeConfig): CatalogEntry[] {
	const providerBlock = config.provider?.[PROVIDER_PLACEHOLDER];
	const models = providerBlock?.models ?? {};

	const deduped = new Map<string, CatalogEntry>();
	for (const [exposedId, value] of Object.entries(models)) {
		const entry = value as { id?: string; name?: string; limit?: CatalogEntry["limit"] };
		const canonicalId = entry.id ?? exposedId;
		if (deduped.has(canonicalId)) {
			continue;
		}

		deduped.set(canonicalId, {
			id: canonicalId,
			exposedId,
			name: entry.name,
			limit: entry.limit,
		});
	}

	return [...deduped.values()].sort((left, right) => left.id.localeCompare(right.id));
}
