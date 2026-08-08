-- Minimal schema for v0: just enough to prove the pipeline works.
-- We'll expand this later (servers table, users, alerts, audit_log, etc.)

CREATE TABLE IF NOT EXISTS health_logs (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    hostname TEXT,
    os TEXT CHECK (os IN ('windows', 'linux')),
    cpu_usage NUMERIC,
    memory_usage NUMERIC,
    disk_usage JSONB,
    uptime_seconds BIGINT,
    last_boot_time TIMESTAMPTZ,
    network_status TEXT,
    backup_status JSONB,
    received_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_health_logs_server_id ON health_logs(server_id);
CREATE INDEX IF NOT EXISTS idx_health_logs_received_at ON health_logs(received_at);
