const USER_ANON_ID_PREFIX = "user:";

export async function getOrCreateAnonymousUserId(
	kv: KVNamespace,
	db: D1Database,
	email: string,
): Promise<string> {
	const kvKey = `${USER_ANON_ID_PREFIX}${email}`;

	try {
		const cachedId = await kv.get(kvKey);
		if (cachedId) {
			return cachedId;
		}
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "Failed to read anonymous user ID from KV",
				email,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}

	const anonymousId = crypto.randomUUID();
	await db
		.prepare(
			"INSERT OR IGNORE INTO users (email, anonymous_id, created_at) VALUES (?, ?, ?)",
		)
		.bind(email, anonymousId, new Date().toISOString())
		.run();

	const user = await db
		.prepare("SELECT anonymous_id FROM users WHERE email = ?")
		.bind(email)
		.first<{ anonymous_id: string }>();

	if (!user?.anonymous_id) {
		throw new Error(`Anonymous user row missing for ${email}`);
	}

	try {
		await kv.put(kvKey, user.anonymous_id);
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "Failed to write anonymous user ID to KV",
				email,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}

	return user.anonymous_id;
}
