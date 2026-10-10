-- Every ordinary row write holds a shared site lock for its transaction. Restore
-- holds the exclusive lock, including across its safety backup and replacement.
-- Also upgrade databases that applied 002 before maintenance leases were added.
CREATE TABLE IF NOT EXISTS maintenance_locks (
 site_id text PRIMARY KEY, task_id text, owner_id text, kind text,
 fencing_token bigint NOT NULL DEFAULT 0, lease_until timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS maintenance_backup_claims (
 site_id text NOT NULL, id text NOT NULL, owner_id text,
 fencing_token bigint NOT NULL DEFAULT 0, lease_until timestamptz NOT NULL DEFAULT now(),
 payload text, pathname text, sha256 text, PRIMARY KEY(site_id,id)
);
CREATE OR REPLACE FUNCTION maintenance_write_guard() RETURNS trigger AS $$
DECLARE guarded_site text;
BEGIN
 guarded_site := CASE WHEN TG_OP = 'DELETE' THEN OLD.site_id ELSE NEW.site_id END;
 IF TG_OP = 'UPDATE' AND OLD.site_id IS DISTINCT FROM NEW.site_id THEN
  RAISE EXCEPTION 'Site IDs cannot be moved between environments' USING ERRCODE = '22023';
 END IF;
 IF current_setting('firefly.restore_site', true) IS DISTINCT FROM guarded_site
    AND NOT pg_try_advisory_xact_lock_shared(hashtext(guarded_site || ':production-write')) THEN
  RAISE EXCEPTION 'Production writes are blocked during restore' USING ERRCODE = '55P03';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['entities','sessions','oauth_states','comments','visitor_bans','friends','media_upload_intents','mail_outbox','release_snapshots','release_tasks','release_locks','maintenance_backups','maintenance_outbox','interaction_rate_limits']
 LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS maintenance_write_guard ON %I', table_name);
  EXECUTE format('CREATE TRIGGER maintenance_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION maintenance_write_guard()', table_name);
 END LOOP;
END;
$$;
