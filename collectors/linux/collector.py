"""
Linux monitoring collector.

Reads real CPU, memory, disk, uptime, and backup stats from the host machine
and POSTs them to POST /api/v1/health every POLL_INTERVAL_SECONDS seconds.

Authentication:
  Each registered server has its own unique agent token.
  Set the AGENT_API_TOKEN environment variable to the plaintext token
  shown when the server was registered in the inventory UI.

  export AGENT_API_TOKEN="<your-64-char-hex-token>"

  The token is sent as:  Authorization: Bearer <token>

  DO NOT print or log the token value.

Configuration (environment variables):
  AGENT_API_TOKEN       required — per-server token from registration
  BACKEND_URL           optional — default http://localhost:4000/api/v1/health
  SERVER_ID             optional — default srv-<hostname>
  POLL_INTERVAL_SECONDS optional — default 60
"""

import os
import time
import platform
import socket
from datetime import datetime, timezone

# Load .env from the same directory as this script (safe no-op if file absent)
from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

import psutil
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BACKEND_URL           = os.environ.get("BACKEND_URL", "http://localhost:4000/api/v1/health")
POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
SERVER_ID             = os.environ.get("SERVER_ID", f"srv-{socket.gethostname().lower()}")

# Token is read once at startup — never printed, never logged.
_AGENT_TOKEN = os.environ.get("AGENT_API_TOKEN", "")


def _check_token():
    if not _AGENT_TOKEN:
        print(
            "[ERROR] AGENT_API_TOKEN environment variable is not set.\n"
            "        Register this server in the inventory UI to obtain a token,\n"
            "        then: export AGENT_API_TOKEN=<token>"
        )
        raise SystemExit(1)


def collect_backup_status():
    """
    Attempt to detect the most recent backup from common Linux tools.
    Returns a dict compatible with the health API's backupStatus field.

    Development/test environment: checks C:\\serverBacks\\backup_test.txt.
    Extend this function to support your backup software
    (rsync, Bacula, Duplicati, etc.).
    """
    test_backup_path = r"C:\serverBacks\backup_test.txt"

    if not os.path.isfile(test_backup_path):
        return {
            "lastBackupTime": None,
            "status":         "unknown",
            "sizeBytes":      None,
            "source":         "test-backup-not-found",
        }

    try:
        stat = os.stat(test_backup_path)
        last_modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        return {
            "lastBackupTime": last_modified,
            "status":         "success",
            "sizeBytes":      stat.st_size,
            "source":         "test-backup",
        }
    except OSError as exc:
        print(f"[WARN]  Could not read backup file metadata: {type(exc).__name__}")
        return {
            "lastBackupTime": None,
            "status":         "unknown",
            "sizeBytes":      None,
            "source":         "test-backup-error",
        }


def collect():
    """Gather a complete health snapshot from this machine."""
    disk_partitions = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
            disk_partitions.append({
                "mount":       part.mountpoint,
                "usedPercent": round(usage.percent, 2),
            })
        except (PermissionError, OSError):
            continue

    boot_ts         = psutil.boot_time()
    uptime_seconds  = int(time.time() - boot_ts)
    last_boot_time  = datetime.fromtimestamp(boot_ts, tz=timezone.utc).isoformat()

    return {
        "hostname":      socket.gethostname(),
        "os":            "linux" if platform.system().lower() != "windows" else "windows",
        "cpuUsage":      psutil.cpu_percent(interval=1),
        "memoryUsage":   psutil.virtual_memory().percent,
        "diskUsage":     disk_partitions,
        "uptimeSeconds": uptime_seconds,
        "lastBootTime":  last_boot_time,
        "networkStatus": "up",
        "backupStatus":  collect_backup_status(),
    }


def send(payload: dict) -> bool:
    """
    POST the payload to the backend.
    Returns True on success, False on recoverable error.
    """
    headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Bearer {_AGENT_TOKEN}",
    }
    try:
        response = requests.post(BACKEND_URL, json=payload, headers=headers, timeout=15)
        if response.status_code == 201:
            data = response.json()
            print(f"[OK] server_id={SERVER_ID}  id={data.get('id')}  receivedAt={data.get('receivedAt')}")
            return True
        elif response.status_code == 401:
            # Do NOT print response body (may contain hints about the token)
            print("[ERROR] Authentication rejected — verify AGENT_API_TOKEN matches the registered token.")
            return False
        elif response.status_code == 422:
            print(
                "[ERROR] Server not registered in inventory.\n"
                "        Register this server via the dashboard before starting the collector."
            )
            return False
        else:
            print(f"[WARN]  Backend responded {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print(f"[WARN]  Cannot reach backend at {BACKEND_URL} — will retry next cycle.")
        return False
    except requests.exceptions.Timeout:
        print("[WARN]  Request to backend timed out — will retry next cycle.")
        return False
    except Exception as exc:  # pylint: disable=broad-except
        print(f"[WARN]  Unexpected error: {type(exc).__name__}")
        return False


def main():
    _check_token()
    print(f"[INFO] Collector starting for server_id={SERVER_ID}")
    print(f"[INFO] Backend: {BACKEND_URL}")
    print(f"[INFO] Poll interval: {POLL_INTERVAL_SECONDS}s  (Ctrl+C to stop)")
    print()

    while True:
        payload = collect()
        send(payload)
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[INFO] Collector stopped.")
