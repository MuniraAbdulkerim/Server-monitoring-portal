"""
Linux/local system collector.

Reads real CPU, memory, disk, and uptime stats from the machine it runs on,
packages them into the JSON shape our backend expects, and POSTs them to
/api/v1/health every 60 seconds.
"""

import time
import uuid
import platform
import socket
import os
from datetime import datetime, timezone

import psutil
import requests

# ---- Config ----
BACKEND_URL = "http://localhost:4000/api/v1/health"
POLL_INTERVAL_SECONDS = 60

# This must match AGENT_API_TOKEN in the backend's .env file.
AGENT_API_TOKEN = os.environ.get("AGENT_API_TOKEN", "replace_with_a_long_random_string")

SERVER_ID = f"srv-{socket.gethostname().lower()}"


def collect_health_data():
    disk_usage = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
            disk_usage.append({
                "mount": part.mountpoint,
                "usedPercent": usage.percent
            })
        except PermissionError:
            continue

    boot_timestamp = psutil.boot_time()
    last_boot_time = datetime.fromtimestamp(boot_timestamp, tz=timezone.utc).isoformat()
    uptime_seconds = int(time.time() - boot_timestamp)

    payload = {
        "serverId": SERVER_ID,
        "hostname": socket.gethostname(),
        "os": "linux" if platform.system().lower() != "windows" else "windows",
        "cpuUsage": psutil.cpu_percent(interval=1),
        "memoryUsage": psutil.virtual_memory().percent,
        "diskUsage": disk_usage,
        "uptimeSeconds": uptime_seconds,
        "lastBootTime": last_boot_time,
        "networkStatus": "up",
        "backupStatus": {
            "lastBackupTime": None,
            "status": "unknown",
            "sizeBytes": None,
            "source": "not-configured-yet"
        }
    }

    return payload


def send_health_data(payload):
    headers = {"Authorization": f"Bearer {AGENT_API_TOKEN}"}
    try:
        response = requests.post(BACKEND_URL, json=payload, headers=headers, timeout=10)
        if response.status_code == 201:
            print(f"[OK] Sent reading for {payload['serverId']} — saved as id {response.json().get('id')}")
        elif response.status_code in (401, 403):
            print(f"[ERROR] Auth rejected — check AGENT_API_TOKEN matches the backend's .env: {response.text}")
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