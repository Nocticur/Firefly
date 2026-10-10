CREATE TABLE IF NOT EXISTS media_upload_intents (
 site_id text NOT NULL, id text NOT NULL, owner_id text NOT NULL,
 pathname text NOT NULL, name text NOT NULL, content_type text NOT NULL,
 size bigint NOT NULL CHECK (size > 0), state text NOT NULL DEFAULT 'pending',
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(site_id,id), UNIQUE(site_id,pathname)
);
CREATE TABLE IF NOT EXISTS comments (
 site_id text NOT NULL, id text NOT NULL, article_id text NOT NULL,
 parent_id text, name text NOT NULL, body text NOT NULL, email text,
 visitor_id text NOT NULL, status text NOT NULL DEFAULT 'visible' CHECK(status IN ('visible','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(site_id,id), FOREIGN KEY(site_id,parent_id) REFERENCES comments(site_id,id)
);
CREATE INDEX IF NOT EXISTS comments_article ON comments(site_id,article_id,created_at);
CREATE TABLE IF NOT EXISTS visitor_bans (
 site_id text NOT NULL, id text NOT NULL, subject text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(site_id,id), UNIQUE(site_id,subject)
);
CREATE TABLE IF NOT EXISTS friends (
 site_id text NOT NULL,id text NOT NULL,name text NOT NULL,url text NOT NULL,
 description text NOT NULL,avatar text NOT NULL DEFAULT '',email text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','published','rejected')),
 group_name text NOT NULL DEFAULT '',sort_order integer NOT NULL DEFAULT 0,
 rejection_reason text,revision bigint NOT NULL DEFAULT 1,published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(site_id,id)
);
CREATE TABLE IF NOT EXISTS interaction_rate_limits (
 site_id text NOT NULL,subject text NOT NULL,window_start timestamptz NOT NULL,
 hits integer NOT NULL,PRIMARY KEY(site_id,subject,window_start)
);
CREATE TABLE IF NOT EXISTS mail_outbox (
 site_id text NOT NULL,id text NOT NULL,notification_key text NOT NULL,
 recipient text NOT NULL,subject text NOT NULL,text_body text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','unknown','blocked','failed')),
 provider_id text,attempts integer NOT NULL DEFAULT 0,first_attempt_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),claimed_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(site_id,id),UNIQUE(site_id,notification_key)
);
CREATE INDEX IF NOT EXISTS mail_pending ON mail_outbox(site_id,status,next_attempt_at);
