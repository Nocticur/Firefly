CREATE TABLE IF NOT EXISTS release_snapshots (
 site_id text NOT NULL, id text NOT NULL, digest text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(site_id,id)
);
CREATE TABLE IF NOT EXISTS release_tasks (
 site_id text NOT NULL, id text NOT NULL, kind text NOT NULL DEFAULT 'publish',
 idempotency_key text NOT NULL, state text NOT NULL, snapshot_id text,
 base_sha text, target_sha text, production_sha text, deployment_id text,
 workflow_id text, message text, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 fence bigint, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(site_id,id), UNIQUE(site_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS release_locks (
 site_id text PRIMARY KEY, task_id text, fencing_token bigint NOT NULL DEFAULT 0,
 lease_until timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS maintenance_backups (
 site_id text NOT NULL, id text NOT NULL, pathname text, sha256 text, state text NOT NULL,
 data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(site_id,id)
);
CREATE TABLE IF NOT EXISTS maintenance_outbox (
 site_id text NOT NULL, date_key text NOT NULL, task_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(site_id,date_key)
);
-- Kept outside backups: a restore must never resurrect an old worker lease.
CREATE TABLE IF NOT EXISTS maintenance_locks (
 site_id text PRIMARY KEY, task_id text, owner_id text, kind text,
 fencing_token bigint NOT NULL DEFAULT 0, lease_until timestamptz NOT NULL DEFAULT now()
);
-- The immutable bytes are frozen before Blob writes, so retries reuse one pathname.
CREATE TABLE IF NOT EXISTS maintenance_backup_claims (
 site_id text NOT NULL, id text NOT NULL, owner_id text,
 fencing_token bigint NOT NULL DEFAULT 0, lease_until timestamptz NOT NULL DEFAULT now(),
 payload text, pathname text, sha256 text, PRIMARY KEY(site_id,id)
);
