-- =============================================================================
-- Server Monitoring Portal — Phase 1 Schema
-- =============================================================================
-- Run order matters: users → servers → health_logs → alerts → thresholds → audit_logs
-- All tables use IF NOT EXISTS so this script is safe to run multiple times
-- (e.g. on a fresh docker-entrypoint-initdb.d init).
-- For migrations against an existing DB use the migrate.sql companion file.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,          -- bcrypt hash, never plaintext
    role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')) DEFAULT 'viewer',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ---------------------------------------------------------------------------
-- Servers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servers (
    id               SERIAL PRIMARY KEY,
    server_id        TEXT UNIQUE NOT NULL,   -- human-readable slug sent by collectors
    name             TEXT NOT NULL,
    ip_or_hostname   TEXT,
    server_type      TEXT,                   -- Web, Database, File, Application, Other
    os               TEXT CHECK (os IN ('windows', 'linux')),
    location         TEXT,                   -- department / physical location
    criticality      TEXT NOT NULL CHECK (criticality IN ('high', 'medium', 'low')) DEFAULT 'medium',
    owner            TEXT,                   -- responsible person or team
    agent_token_hash TEXT,                   -- bcrypt hash of the per-server agent token
    last_seen_at     TIMESTAMPTZ,            -- updated each time a health reading arrives
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_servers_server_id   ON servers(server_id);
CREATE INDEX IF NOT EXISTS idx_servers_last_seen_at ON servers(last_seen_at);

-- ---------------------------------------------------------------------------
-- Health Logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS health_logs (
    id             SERIAL PRIMARY KEY,
    server_id      TEXT NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
    hostname       TEXT,
    os             TEXT CHECK (os IN ('windows', 'linux')),
    cpu_usage      NUMERIC CHECK (cpu_usage    >= 0 AND cpu_usage    <= 100),
    memory_usage   NUMERIC CHECK (memory_usage >= 0 AND memory_usage <= 100),
    disk_usage     JSONB,
    uptime_seconds BIGINT CHECK (uptime_seconds >= 0),
    last_boot_time TIMESTAMPTZ,
    network_status TEXT,
    backup_status  JSONB,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_health_logs_server_id   ON health_logs(server_id);
CREATE INDEX IF NOT EXISTS idx_health_logs_received_at ON health_logs(received_at);
CREATE INDEX IF NOT EXISTS idx_health_logs_server_recv ON health_logs(server_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- Alerts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
    id          SERIAL PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(server_id) ON DELETE CASCADE,
    alert_type  TEXT NOT NULL,
    severity    TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    message     TEXT NOT NULL,
    resolved    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alerts_server_id ON alerts(server_id);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved  ON alerts(resolved);
CREATE INDEX IF NOT EXISTS idx_alerts_created   ON alerts(created_at DESC);

-- ---------------------------------------------------------------------------
-- Thresholds  (one row per server, NULL server_id = global default)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thresholds (
    id                    SERIAL PRIMARY KEY,
    server_id             TEXT REFERENCES servers(server_id) ON DELETE CASCADE,
    cpu_warning           NUMERIC NOT NULL DEFAULT 70  CHECK (cpu_warning    BETWEEN 0 AND 100),
    cpu_critical          NUMERIC NOT NULL DEFAULT 90  CHECK (cpu_critical   BETWEEN 0 AND 100),
    memory_warning        NUMERIC NOT NULL DEFAULT 75  CHECK (memory_warning BETWEEN 0 AND 100),
    memory_critical       NUMERIC NOT NULL DEFAULT 90  CHECK (memory_critical BETWEEN 0 AND 100),
    disk_warning          NUMERIC NOT NULL DEFAULT 80  CHECK (disk_warning   BETWEEN 0 AND 100),
    disk_critical         NUMERIC NOT NULL DEFAULT 90  CHECK (disk_critical  BETWEEN 0 AND 100),
    backup_stale_hours    NUMERIC NOT NULL DEFAULT 24  CHECK (backup_stale_hours > 0),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT thresholds_server_id_unique UNIQUE (server_id)
);

-- Insert the global default row (server_id IS NULL means "applies to all")
INSERT INTO thresholds (server_id)
VALUES (NULL)
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_thresholds_server_id ON thresholds(server_id);

-- ---------------------------------------------------------------------------
-- Audit Logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,          -- e.g. SERVER_CREATED, TOKEN_GENERATED
    target_type TEXT,                   -- e.g. 'server', 'threshold'
    target_id   TEXT,                   -- the affected record's id / server_id
    metadata    JSONB,                  -- extra context — NEVER store secrets
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action     ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target     ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
