# Server Monitor — v0 (walking skeleton)

This is step 1: a real backend + database, no collectors or dashboard yet.
Goal: prove data can be sent in and read back out.

## Run it

1. Install Docker Desktop if you don't have it: https://www.docker.com/products/docker-desktop/
2. From the project root, start Postgres:
   ```
   docker compose up -d
   ```
   This creates the database and automatically runs `database/schema.sql` to create the `health_logs` table.

3. Set up the backend:
   ```
   cd backend
   cp .env.example .env
   npm install
   npm run dev
   ```
   You should see: `server-monitor backend listening on http://localhost:4000`

## Test it manually (before any collector exists)

Send a fake reading with curl:
```bash
curl -X POST http://localhost:4000/api/v1/health \
  -H "Content-Type: application/json" \
  -d '{
    "serverId": "srv-001",
    "hostname": "test-linux-01",
    "os": "linux",
    "cpuUsage": 42.5,
    "memoryUsage": 63.2,
    "diskUsage": [{ "mount": "/", "usedPercent": 71 }],
    "uptimeSeconds": 123456,
    "lastBootTime": "2026-08-01T10:00:00Z",
    "networkStatus": "up",
    "backupStatus": { "lastBackupTime": "2026-08-08T02:00:00Z", "status": "success", "sizeBytes": 1048576, "source": "rsync" }
  }'
```

Then read it back:
```bash
curl http://localhost:4000/api/v1/health
```

If you see your fake reading come back as JSON — the whole backend + database pipeline works.

## What's next
- [ ] Python collector using `psutil` (real Linux data) → posts here
- [ ] Python "fake Windows collector" script → posts here too
- [ ] React dashboard → calls `GET /api/v1/health`
- [ ] Auth (Bearer token), alerts, reports, audit log
