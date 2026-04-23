import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

type AccessUserMetadata = {
	email: string;
};

type AccessClaims = JWTPayload & {
	email?: unknown;
	common_name?: unknown;
	name?: unknown;
};

let cachedJwksUrl: string | undefined;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function verifyAccessToken(
	token: string,
	env: Env,
): Promise<JWTPayload> {
	const issuer = env.TEAM_DOMAIN;
	const jwksUrl = `${issuer.replace(/\/$/, "")}/cdn-cgi/access/certs`;
	const jwks = getRemoteJwks(jwksUrl);

	const { payload } = await jwtVerify(token, jwks, {
		issuer,
		audience: env.POLICY_AUD,
	});

	return payload;
}

export function extractAccessToken(headers: Headers): string | null {
	const assertion = headers.get("cf-access-jwt-assertion");
	if (assertion) {
		return assertion;
	}

	const bearer = headers.get("authorization");
	if (bearer?.startsWith("Bearer ")) {
		return bearer.slice("Bearer ".length).trim();
	}

	return headers.get("cf-access-token");
}

export function getAccessUserMetadata(payload: AccessClaims): AccessUserMetadata | null {
	const email = pickString(payload.email);
	if (!email) {
		return null;
	}

	return { email };
}

function getRemoteJwks(url: string) {
	if (cachedJwksUrl !== url) {
		cachedJwks = createRemoteJWKSet(new URL(url));
		cachedJwksUrl = url;
	}

	if (!cachedJwks) {
		throw new Error("Remote JWKS cache did not initialize");
	}

	return cachedJwks;
}

function pickString(...candidates: unknown[]): string | null {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}

	return null;
}
