# Server Monitor — v0 (walking skeleton)

This is step 1: a real backend + database, no collectors or dashboard yet.
Goal: prove data can be sent in and read back out.

## Run it

1. Install Docker Desktop if you don't have it: https://www.docker.com/products/docker-desktop/
   - **Windows users:** Docker needs WSL2. If Docker Desktop shows "Virtualization support not detected" on first launch, open PowerShell **as Administrator** and run `wsl --install`, then restart your PC. If that fails with "Catastrophic failure," instead run these two commands as admin, restart, then reinstall Docker Desktop:
     ```
     dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
     dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
     ```
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

### If you get "password authentication failed for user monitor_user"

This almost always means something *else* on your machine is already using port 5432 (commonly a Postgres install from an old project), so your app connects to that instead of our Docker container.

Check for a conflict:
```
netstat -ano | findstr :5432
```
If you see **two** lines, something else owns that port. Don't uninstall or stop it if you're not sure what it's for — instead, remap our container's port in `docker-compose.yml`:
```yaml
    ports:
      - "5433:5432"
```
and update `backend/.env`:
```
DB_PORT=5433
```
Then `docker compose down && docker compose up -d` and restart the backend.

### If you get "address already in use :::4000" (or :::5432)

An old process is still running in the background. Find and stop it:
```
netstat -ano | findstr :4000
taskkill /PID <the_number_you_see> /F
```

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