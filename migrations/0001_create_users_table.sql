CREATE TABLE IF NOT EXISTS users (
	email TEXT PRIMARY KEY,
	anonymous_id TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_anonymous_id ON users(anonymous_id);
