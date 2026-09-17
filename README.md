# Server Monitoring Portal — Phase 1

A self-hosted infrastructure monitoring system. Linux servers run a lightweight
Python collector that POSTs health metrics to a Node.js/Express backend. A React
dashboard displays live status, alerts, and server inventory.

---

## Architecture

```
┌─────────────────────┐        Bearer token         ┌──────────────────────┐
│  Linux Collector    │ ──POST /api/v1/health──────▶ │   Express Backend    │
│  (collector.py)     │      (per-server token)      │   (Node.js / pg)     │
└─────────────────────┘                              └──────────┬───────────┘
                                                                │ SQL
                                                     ┌──────────▼───────────┐
┌─────────────────────┐        REST API              │   PostgreSQL 16       │
│  React Dashboard    │ ◀──── /api/v1/* ──────────── │   (Docker)            │
│  (Vite + React 19)  │                              └──────────────────────┘
└─────────────────────┘
```

### Database tables

| Table          | Purpose |
|----------------|---------|
| `servers`      | Registered server inventory (name, OS, location, agent token hash) |
| `health_logs`  | Time-series health readings (FK → servers) |
| `alerts`       | Threshold-triggered alerts (FK → servers) |
| `thresholds`   | Configurable per-server or global thresholds |
| `users`        | Dashboard users (Phase 1 schema only) |
| `audit_logs`   | Administrative and security event log |

---

## Project Structure

```
.
├── backend/
│   ├── src/
│   │   ├── server.js           — main Express app
│   │   ├── db.js               — pg Pool
│   │   ├── middleware/
│   │   │   ├── auth.js         — per-server Bearer token middleware
│   │   │   └── errorHandler.js — centralized error handling
│   │   ├── routes/
│   │   │   ├── servers.js      — server CRUD + token management
│   │   │   └── alerts.js       — alert query + resolve
│   │   ├── services/
│   │   │   ├── audit.js        — audit log writer
│   │   │   └── status.js       — ONLINE/OFFLINE/WARNING/CRITICAL logic
│   │   ├── alerts/
│   │   │   ├── checkThresholds.js  — threshold evaluation (reads from DB)
│   │   │   └── emailer.js          — optional SMTP notification
│   │   └── tests/
│   │       ├── status.test.js  — unit tests (no DB)
│   │       └── api.test.js     — integration tests (requires DB)
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── App.jsx             — dashboard + summary + alerts banner
│   │   ├── App.css             — design system (dark theme)
│   │   ├── main.jsx
│   │   ├── services/
│   │   │   └── api.js          — centralized API service layer
│   │   └── components/
│   │       └── Inventory.jsx   — server CRUD UI + token reveal
│   ├── package.json
│   └── .env.example
├── collectors/
│   └── linux/
│       ├── collector.py        — Linux psutil collector
│       └── requirements.txt
├── database/
│   ├── schema.sql              — full Phase 1 schema (fresh install)
│   └── migrate.sql             — migration for existing v0 databases
└── docker-compose.yml
```

---

## Installation

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (for PostgreSQL)
- Node.js 20+ and npm
- Python 3.9+ with pip (for the collector)

### 1. Start PostgreSQL

```bash
docker compose up -d
```

This creates the database and runs `database/schema.sql` automatically on first
start. The global threshold defaults are seeded automatically.

**Port conflict?** If port 5432 is already in use, the compose file maps `5433:5432`.
Update `DB_PORT=5433` in `backend/.env` if needed.

### 2. Configure the backend

```bash
cd backend
cp .env.example .env
# Edit .env — the defaults work with docker-compose as-is
npm install
npm run dev
```

You should see:
```
[SERVER] server-monitor backend listening on http://localhost:4000
```

### 3. Configure and start the frontend

```bash
cd frontend
cp .env.example .env     # optional — defaults to http://localhost:4000/api/v1
npm install
npm run dev
```

Open http://localhost:5173

---

## Environment Variables

### Backend (`backend/.env`)

| Variable                       | Default                    | Description |
|--------------------------------|----------------------------|-------------|
| `PORT`                         | `4000`                     | HTTP port |
| `DB_HOST`                      | `localhost`                | PostgreSQL host |
| `DB_PORT`                      | `5433`                     | PostgreSQL port |
| `DB_USER`                      | `monitor_user`             | DB user |
| `DB_PASSWORD`                  | `monitor_pass`             | DB password |
| `DB_NAME`                      | `server_monitor`           | DB name |
| `CORS_ORIGIN`                  | `http://localhost:5173`    | Allowed browser origins (comma-separated) |
| `SERVER_OFFLINE_TIMEOUT_SECONDS` | `300`                  | Seconds without a health report before marking a server OFFLINE |
| `SMTP_HOST`                    | *(unset)*                  | SMTP server (optional — email alerts skipped if not set) |
| `SMTP_PORT`                    | `587`                      | SMTP port |
| `SMTP_USER`                    | *(unset)*                  | SMTP username |
| `SMTP_PASS`                    | *(unset)*                  | SMTP password |
| `ALERT_EMAIL_FROM`             | *(unset)*                  | Sender address |
| `ALERT_EMAIL_TO`               | *(unset)*                  | Recipient address |

### Frontend (`frontend/.env`)

| Variable        | Default                          | Description |
|-----------------|----------------------------------|-------------|
| `VITE_API_URL`  | `http://localhost:4000/api/v1`   | Backend API base URL |

---

## Database

### Fresh install

```bash
docker compose up -d
# schema.sql is applied automatically by the Postgres init script
```

### Migrate an existing v0 database

```bash
# Connect to the running Postgres container
docker exec -i server-monitor-db psql -U monitor_user -d server_monitor \
  < database/migrate.sql
```

---

## Server Registration & Agent Authentication

Each registered server gets its own unique agent token. The token is shown
**exactly once** at registration — store it securely. It is never stored in
plaintext; only its bcrypt hash lives in the database.

### Register a server via the API

```bash
curl -X POST http://localhost:4000/api/v1/servers \
  -H "Content-Type: application/json" \
  -d '{
    "serverId":     "srv-web01",
    "name":         "Web Server 01",
    "ipOrHostname": "192.168.1.10",
    "serverType":   "Web",
    "os":           "linux",
    "location":     "Server Room A",
    "criticality":  "high",
    "owner":        "Ops Team"
  }'
```

Response:
```json
{
  "success": true,
  "message": "Server registered. Save the agentToken — it will not be shown again.",
  "agentToken": "a3f9...64 hex chars...",
  "data": { "id": 1, "server_id": "srv-web01", ... }
}
```

### Regenerate a token

```bash
curl -X POST http://localhost:4000/api/v1/servers/srv-web01/regenerate-token
```

---

## Running the Linux Collector

```bash
cd collectors/linux
pip install -r requirements.txt

# Set the token from server registration
export AGENT_API_TOKEN="a3f9...your-token..."

# Optional overrides
export BACKEND_URL="http://your-backend:4000/api/v1/health"
export SERVER_ID="srv-web01"         # default: srv-<hostname>
export POLL_INTERVAL_SECONDS=60      # default: 60

python collector.py
```

The collector sends data every 60 seconds. It handles connection failures
gracefully and retries on the next cycle. The token is never logged.

---

## API Endpoints

### Health

| Method | Path                        | Auth   | Description |
|--------|-----------------------------|--------|-------------|
| `POST` | `/api/v1/health`            | Bearer | Submit a health reading (collector endpoint) |
| `GET`  | `/api/v1/health`            | None   | Latest reading per server (dashboard) |
| `GET`  | `/api/v1/health/:serverId`  | None   | Last 100 readings for one server |

### Servers

| Method   | Path                                     | Description |
|----------|------------------------------------------|-------------|
| `GET`    | `/api/v1/servers`                        | List all servers with live status |
| `GET`    | `/api/v1/servers/:serverId`              | Get one server |
| `POST`   | `/api/v1/servers`                        | Register a server (returns token once) |
| `PUT`    | `/api/v1/servers/:serverId`              | Update server details |
| `DELETE` | `/api/v1/servers/:serverId`              | Remove a server |
| `POST`   | `/api/v1/servers/:serverId/regenerate-token` | Issue a new agent token |

### Alerts

| Method | Path                         | Description |
|--------|------------------------------|-------------|
| `GET`  | `/api/v1/alerts`             | Active (unresolved) alerts |
| `GET`  | `/api/v1/alerts?all=true`    | All alerts including resolved (last 200) |
| `PUT`  | `/api/v1/alerts/:id/resolve` | Manually resolve an alert |

### Example health submission

```bash
curl -X POST http://localhost:4000/api/v1/health \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <agent-token>" \
  -d '{
    "hostname":      "web01.example.com",
    "os":            "linux",
    "cpuUsage":      42.5,
    "memoryUsage":   63.2,
    "diskUsage":     [{ "mount": "/", "usedPercent": 71 }],
    "uptimeSeconds": 123456,
    "lastBootTime":  "2026-08-01T10:00:00Z",
    "networkStatus": "up",
    "backupStatus":  {
      "lastBackupTime": "2026-09-13T02:00:00Z",
      "status":         "success",
      "sizeBytes":      1048576,
      "source":         "rsync"
    }
  }'
```

---

## Testing

```bash
cd backend
npm test
```

- **Unit tests** (no DB required): `status.test.js` — 8 tests for status logic
- **Integration tests** (DB required): `api.test.js` — 23 tests

If no database is available, DB-dependent tests are automatically skipped.
To force-skip all DB tests:

```bash
SKIP_DB_TESTS=true npm test
```

---

## Server Status Logic

| Status     | Condition |
|------------|-----------|
| `offline`  | No report received, or last report older than `SERVER_OFFLINE_TIMEOUT_SECONDS` |
| `critical` | Recent report; CPU ≥ 90%, memory ≥ 90%, or disk ≥ 90% |
| `warning`  | Recent report; CPU ≥ 70%, memory ≥ 75%, or disk ≥ 80% |
| `online`   | Recent report; all metrics below warning thresholds |

Thresholds are stored in the `thresholds` table and can be set per-server or
globally (the global default row has `server_id = NULL`).

---

## Security Notes

- Each server has a unique 64-character hex agent token stored as a bcrypt hash (cost 12).
- Tokens are shown only once at registration and never logged.
- Authentication failures are audit-logged (no token value stored in logs).
- CORS is restricted to `CORS_ORIGIN` — not wide open.
- Zod validates all incoming data; 400 is returned for invalid payloads.
- Server identity on health submissions comes from the authenticated token, not the request body.
- Stack traces are hidden in production (`NODE_ENV=production`).

---

## Troubleshooting

### "password authentication failed for user monitor_user"

Something else is using port 5432. The docker-compose maps `5433:5432` by default.
Check your `DB_PORT` in `backend/.env` is `5433`.

### "address already in use :::4000"

```
netstat -ano | findstr :4000
taskkill /PID <number> /F
```

### Collector shows "Authentication rejected"

The `AGENT_API_TOKEN` env var doesn't match the registered token. Re-register the
server (or use `/regenerate-token`) to get a new token, then update the env var.

### Collector shows "Server not registered in inventory"

Register the server in the dashboard (Manage Servers tab) first, then start
the collector with the token from registration.

---

## Phase 2 Backlog

- Windows collector (PowerShell / WMI)
- Dashboard user authentication (login / sessions)
- Per-server threshold configuration UI
- Historical charts (health trends over time)
- Advanced backup integrations (Veeam, Bacula, rsync detection)
- Alert acknowledgement workflow
- SMS notifications
- Role-based access control
- Kubernetes / production deployment
