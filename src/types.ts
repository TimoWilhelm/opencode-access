export type AppBindings = {
	Bindings: Env;
	Variables: {
		anonymousUserId: string;
	};
};

export type ModelLimit = {
	context?: number;
	output?: number;
};

export type CatalogEntry = {
	/** Canonical model id forwarded to AI Gateway (e.g. "anthropic/claude-4-7-opus"). */
	id: string;
	/** Model id exposed to clients in the discovery envelope and /v1/models. */
	exposedId: string;
	name?: string;
	limit?: ModelLimit;
};

export type StoredCatalog = {
	models: CatalogEntry[];
	source: string;
	syncedAt: string;
};
