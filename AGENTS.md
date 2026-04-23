# Repository

- Runtime: Cloudflare Workers with Hono
- Test command: `npm test`
- Type generation: `npm run cf-typegen`

# Architecture

- `src/index.ts` contains the small Worker entrypoint wiring.
- `src/app.ts` contains the Hono routes and request flow.
- `src/access.ts`, `src/catalog.ts`, `src/discovery.ts`, and `src/ai-gateway.ts` contain the auth, catalog, discovery, and proxy logic.
- `src/default-model-catalog.ts` contains the bundled model catalog for the demo.

# Conventions

- Keep `/.well-known/opencode` public so OpenCode can bootstrap authentication.
- Keep `/v1/*` behind Cloudflare Access token verification inside the Worker.
- Do not store real secrets in `wrangler.jsonc`; use `wrangler secret put`.

# Boundaries

- Do not add organization-specific hostnames, provider keys, or internal tooling defaults to the template.
- Prefer AI Gateway controls and Access identity over provider-specific client configuration.
