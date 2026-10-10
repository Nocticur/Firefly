CREATE TABLE IF NOT EXISTS entities (
 site_id text NOT NULL,
 kind text NOT NULL,
 id text NOT NULL,
 data jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (site_id, kind, id)
);
CREATE INDEX IF NOT EXISTS entities_site_kind_updated ON entities(site_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS entities_post_versions ON entities(site_id, (data->>'postId')) WHERE kind = 'post_version';
CREATE TABLE IF NOT EXISTS sessions (
 site_id text NOT NULL,
 token_hash text NOT NULL,
 user_data jsonb NOT NULL,
 csrf_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (site_id, token_hash)
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS oauth_states (
 site_id text NOT NULL,
 state_hash text NOT NULL,
 cookie_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (site_id, state_hash)
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS schema_migrations (
 id text PRIMARY KEY,
 applied_at timestamptz NOT NULL DEFAULT now()
);
