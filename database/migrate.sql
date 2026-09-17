-- =============================================================================
-- Server Monitoring Portal — Phase 1 Migration
-- Safely upgrades an existing v0 database (health_logs + servers + alerts only)
-- to the full Phase 1 schema.
--
-- Safe to re-run: all DDL uses IF NOT EXISTS or DO-blocks that check
-- the information_schema before acting.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add new columns to servers
-- ---------------------------------------------------------------------------
ALTER TABLE servers ADD COLUMN IF NOT EXISTS agent_token_hash TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS last_seen_at     TIMESTAMPTZ;

-- updated_at may already exist in old schema; add only if absent
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'servers' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE servers ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END;
$$;

-- New indexes
CREATE INDEX IF NOT EXISTS idx_servers_last_seen_at ON servers(last_seen_at);

-- ---------------------------------------------------------------------------
-- 2. Add CHECK constraints to health_logs (only if not already present)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'health_logs_cpu_usage_check'
  ) THEN
    -- Clamp any existing bad values first so the constraint won't reject them
    UPDATE health_logs
       SET cpu_usage = LEAST(GREATEST(cpu_usage, 0), 100)
     WHERE cpu_usage IS NOT NULL
       AND (cpu_usage < 0 OR cpu_usage > 100);

    ALTER TABLE health_logs
      ADD CONSTRAINT health_logs_cpu_usage_check
      CHECK (cpu_usage >= 0 AND cpu_usage <= 100);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'health_logs_memory_usage_check'
  ) THEN
    UPDATE health_logs
       SET memory_usage = LEAST(GREATEST(memory_usage, 0), 100)
     WHERE memory_usage IS NOT NULL
       AND (memory_usage < 0 OR memory_usage > 100);

    ALTER TABLE health_logs
      ADD CONSTRAINT health_logs_memory_usage_check
      CHECK (memory_usage >= 0 AND memory_usage <= 100);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'health_logs_uptime_seconds_check'
  ) THEN
    UPDATE health_logs
       SET uptime_seconds = GREATEST(uptime_seconds, 0)
     WHERE uptime_seconds IS NOT NULL AND uptime_seconds < 0;

    ALTER TABLE health_logs
      ADD CONSTRAINT health_logs_uptime_seconds_check
      CHECK (uptime_seconds >= 0);
  END IF;
END;
$$;

-- received_at NOT NULL (was nullable in v0)
DO $$
BEGIN
  -- Set a default for any NULLs first
  UPDATE health_logs SET received_at = now() WHERE received_at IS NULL;

  -- Add NOT NULL if column is still nullable
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'health_logs'
      AND column_name = 'received_at'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE health_logs ALTER COLUMN received_at SET NOT NULL;
    ALTER TABLE health_logs ALTER COLUMN received_at SET DEFAULT now();
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Add FK from health_logs → servers  (only if not already present)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'health_logs_server_id_fkey'
      AND table_name       = 'health_logs'
  ) THEN
    -- Delete orphaned health_logs rows that have no matching server
    DELETE FROM health_logs
     WHERE server_id NOT IN (SELECT server_id FROM servers);

    ALTER TABLE health_logs
      ADD CONSTRAINT health_logs_server_id_fkey
      FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE;
  END IF;
END;
$$;

-- Composite index for "latest per server" queries
CREATE INDEX IF NOT EXISTS idx_health_logs_server_recv
  ON health_logs(server_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Add FK from alerts → servers  (only if not already present)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'alerts_server_id_fkey'
      AND table_name       = 'alerts'
  ) THEN
    DELETE FROM alerts
     WHERE server_id NOT IN (SELECT server_id FROM servers);

    ALTER TABLE alerts
      ADD CONSTRAINT alerts_server_id_fkey
      FOREIGN KEY (server_id) REFERENCES servers(server_id) ON DELETE CASCADE;
  END IF;
END;
$$;

-- Add NOT NULL / DEFAULT to alerts columns that were nullable in v0
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'alerts' AND column_name = 'resolved' AND is_nullable = 'YES'
  ) THEN
    UPDATE alerts SET resolved = false WHERE resolved IS NULL;
    ALTER TABLE alerts ALTER COLUMN resolved SET NOT NULL;
    ALTER TABLE alerts ALTER COLUMN resolved SET DEFAULT false;
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'alerts' AND column_name = 'created_at' AND is_nullable = 'YES'
  ) THEN
    UPDATE alerts SET created_at = now() WHERE created_at IS NULL;
    ALTER TABLE alerts ALTER COLUMN created_at SET NOT NULL;
    ALTER TABLE alerts ALTER COLUMN created_at SET DEFAULT now();
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. New table: users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')) DEFAULT 'viewer',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ---------------------------------------------------------------------------
-- 6. New table: thresholds  (NULL server_id = global default)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thresholds (
    id                 SERIAL PRIMARY KEY,
    server_id          TEXT REFERENCES servers(server_id) ON DELETE CASCADE,
    cpu_warning        NUMERIC NOT NULL DEFAULT 70  CHECK (cpu_warning    BETWEEN 0 AND 100),
    cpu_critical       NUMERIC NOT NULL DEFAULT 90  CHECK (cpu_critical   BETWEEN 0 AND 100),
    memory_warning     NUMERIC NOT NULL DEFAULT 75  CHECK (memory_warning BETWEEN 0 AND 100),
    memory_critical    NUMERIC NOT NULL DEFAULT 90  CHECK (memory_critical BETWEEN 0 AND 100),
    disk_warning       NUMERIC NOT NULL DEFAULT 80  CHECK (disk_warning   BETWEEN 0 AND 100),
    disk_critical      NUMERIC NOT NULL DEFAULT 90  CHECK (disk_critical  BETWEEN 0 AND 100),
    backup_stale_hours NUMERIC NOT NULL DEFAULT 24  CHECK (backup_stale_hours > 0),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT thresholds_server_id_unique UNIQUE (server_id)
);

CREATE INDEX IF NOT EXISTS idx_thresholds_server_id ON thresholds(server_id);

-- Seed the global default row
INSERT INTO thresholds (server_id)
VALUES (NULL)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. New table: audit_logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    metadata    JSONB,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action     ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target     ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
