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
-- Server inventory: the list of servers we intend to monitor,
-- separate from health_logs (which is just incoming readings).
CREATE TABLE IF NOT EXISTS servers (
    id SERIAL PRIMARY KEY,
    server_id TEXT UNIQUE NOT NULL,        -- matches the serverId sent by collectors
    name TEXT NOT NULL,
    ip_or_hostname TEXT,
    server_type TEXT,                       -- Web, Database, File, Application, etc.
    os TEXT CHECK (os IN ('windows', 'linux')),
    location TEXT,                          -- e.g. department or physical location
    criticality TEXT CHECK (criticality IN ('high', 'medium', 'low')) DEFAULT 'medium',
    owner TEXT,                             -- responsible person
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_servers_server_id ON servers(server_id);

-- Alerts: triggered when a health reading crosses a threshold
CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
    message TEXT NOT NULL,
    resolved BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alerts_server_id ON alerts(server_id);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved);