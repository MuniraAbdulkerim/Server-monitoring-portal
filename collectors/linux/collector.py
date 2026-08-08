"""
Linux/local system collector.

Reads real CPU, memory, disk, and uptime stats from the machine it runs on,
packages them into the JSON shape our backend expects, and POSTs them to
/api/v1/health every 60 seconds.

Note: this reads REAL stats from whatever machine you run it on (even Windows,
for testing). In production this would run ON the actual Linux servers being
monitored, and you'd add real backup-log checking (rsync/Bacula logs) instead
of the placeholder backup_status below.
"""

import time
import uuid
import platform
import socket
from datetime import datetime, timezone

import psutil
import requests

# ---- Config ----
BACKEND_URL = "http://localhost:4000/api/v1/health"
POLL_INTERVAL_SECONDS = 60

# Each server needs a stable ID so the backend/dashboard can tell it apart
# from other servers. For now we generate one based on the hostname.
SERVER_ID = f"srv-{socket.gethostname().lower()}"


def collect_health_data():
    """Gather real system stats and shape them to match the API contract."""

    disk_usage = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
            disk_usage.append({
                "mount": part.mountpoint,
                "usedPercent": usage.percent
            })
        except PermissionError:
            # Some mounts (like removable media) can't always be read — skip them
            continue

    boot_timestamp = psutil.boot_time()
    last_boot_time = datetime.fromtimestamp(boot_timestamp, tz=timezone.utc).isoformat()
    uptime_seconds = int(time.time() - boot_timestamp)

    payload = {
        "serverId": SERVER_ID,
        "hostname": socket.gethostname(),
        # Reports what OS this collector is actually running on.
        # Real deployment: this script runs ON a Linux server, so this will say "linux".
        "os": "linux" if platform.system().lower() != "windows" else "windows",
        "cpuUsage": psutil.cpu_percent(interval=1),
        "memoryUsage": psutil.virtual_memory().percent,
        "diskUsage": disk_usage,
        "uptimeSeconds": uptime_seconds,
        "lastBootTime": last_boot_time,
        "networkStatus": "up",  # if this script is running and can reach the network, it's up
        "backupStatus": {
            # PLACEHOLDER: real version should check actual backup software logs
            # (e.g. parse rsync log output or Bacula's job status) for the real
            # last backup time/status/size. Hardcoded here just to prove the pipeline.
            "lastBackupTime": None,
            "status": "unknown",
            "sizeBytes": None,
            "source": "not-configured-yet"
        }
    }

    return payload


def send_health_data(payload):
    try:
        response = requests.post(BACKEND_URL, json=payload, timeout=10)
        if response.status_code == 201:
            print(f"[OK] Sent reading for {payload['serverId']} — saved as id {response.json().get('id')}")
        else:
            print(f"[WARN] Backend responded {response.status_code}: {response.text}")
    except requests.exceptions.ConnectionError:
        print("[ERROR] Could not reach backend — is it running? (npm run dev)")
    except requests.exceptions.Timeout:
        print("[ERROR] Request to backend timed out")


def main():
    print(f"Starting collector for server '{SERVER_ID}' — sending to {BACKEND_URL}")
    print(f"Polling every {POLL_INTERVAL_SECONDS} seconds. Press Ctrl+C to stop.\n")

    while True:
        payload = collect_health_data()
        send_health_data(payload)
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCollector stopped.")
