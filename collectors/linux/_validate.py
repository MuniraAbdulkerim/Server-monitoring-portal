"""
Safe validation script -- does NOT start the poll loop, does NOT post real data.
Run from: collectors/linux/
"""
import os, sys, json, socket, platform, time
from datetime import datetime, timezone
from dotenv import load_dotenv

# 1. Load .env from same directory as this script
env_path = os.path.join(os.path.dirname(__file__), ".env")
loaded = load_dotenv(dotenv_path=env_path)
print(f"[1] .env file found and loaded : {loaded}")

# 2. Show config values (token shown as length only — never the value)
backend_url = os.environ.get("BACKEND_URL", "http://localhost:4000/api/v1/health")
server_id   = os.environ.get("SERVER_ID",   f"srv-{socket.gethostname().lower()}")
token       = os.environ.get("AGENT_API_TOKEN", "")
token_status = f"SET (length {len(token)})" if token else "NOT SET"

print(f"[2] BACKEND_URL     : {backend_url}")
print(f"[2] SERVER_ID       : {server_id}")
print(f"[2] AGENT_API_TOKEN : {token_status}")

# 3. collect_backup_status()
test_backup_path = r"C:\serverBacks\backup_test.txt"
if not os.path.isfile(test_backup_path):
    backup = {
        "lastBackupTime": None,
        "status":         "unknown",
        "sizeBytes":      None,
        "source":         "test-backup-not-found",
    }
else:
    stat = os.stat(test_backup_path)
    backup = {
        "lastBackupTime": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "status":         "success",
        "sizeBytes":      stat.st_size,
        "source":         "test-backup",
    }

print(f"[3] backupStatus.status        : {backup['status']}")
print(f"[3] backupStatus.sizeBytes     : {backup['sizeBytes']}")
print(f"[3] backupStatus.source        : {backup['source']}")
print(f"[3] backupStatus.lastBackupTime: {backup['lastBackupTime']}")

# 4. Build full health payload (same as collect())
import psutil
disk_partitions = []
for part in psutil.disk_partitions(all=False):
    try:
        usage = psutil.disk_usage(part.mountpoint)
        disk_partitions.append({"mount": part.mountpoint, "usedPercent": round(usage.percent, 2)})
    except (PermissionError, OSError):
        continue

boot_ts        = psutil.boot_time()
uptime_seconds = int(time.time() - boot_ts)
last_boot_time = datetime.fromtimestamp(boot_ts, tz=timezone.utc).isoformat()

payload = {
    "serverId":      server_id,
    "hostname":      socket.gethostname(),
    "os":            "linux" if platform.system().lower() != "windows" else "windows",
    "cpuUsage":      psutil.cpu_percent(interval=1),
    "memoryUsage":   psutil.virtual_memory().percent,
    "diskUsage":     disk_partitions,
    "uptimeSeconds": uptime_seconds,
    "lastBootTime":  last_boot_time,
    "networkStatus": "up",
    "backupStatus":  backup,
}

print(f"[4] Payload built OK — keys: {list(payload.keys())}")
print(f"[4] cpuUsage        : {payload['cpuUsage']}%")
print(f"[4] memoryUsage     : {payload['memoryUsage']}%")
print(f"[4] diskUsage       : {payload['diskUsage']}")

# 5. Backend reachability check
import requests as req
try:
    r = req.get("http://localhost:4000/", timeout=5)
    msg = r.json().get("message", r.text)
    print(f"[5] Backend reachable  : YES — {msg}")
except Exception as exc:
    print(f"[5] Backend reachable  : NO  — {exc}")

# 6. Final verdict
print()
if not token:
    print("[6] RESULT: NOT READY — AGENT_API_TOKEN is missing.")
    print("    Create collectors/linux/.env with your token (see instructions above).")
    sys.exit(1)
else:
    print("[6] RESULT: READY — all configuration is present. Run collector.py to start.")
