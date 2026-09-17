/**
 * System metrics controller.
 *
 * Uses the `systeminformation` package for cross-platform metrics.
 * Falls back to Node.js built-in `os` module where possible.
 *
 * A 3-second in-memory cache prevents concurrent requests (or rapid test
 * calls) from stacking si.currentLoad() measurements, which each take ~1 s.
 */
import si   from "systeminformation";
import os   from "os";

// ---------------------------------------------------------------------------
// Simple TTL cache — avoids stacking slow si calls during tests
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 3000;
let _metricsCache    = null;
let _metricsCachedAt = 0;
let _statusCache     = null;
let _statusCachedAt  = 0;

// Pre-warm the status cache at module load — but only outside of test runs.
// si.osInfo() can take 15-30 s on a cold Windows system; running it once at
// startup means the first HTTP request hits the cache rather than waiting.
if (process.env.NODE_ENV !== "test" && process.env.VITEST == null) {
  (async () => {
    try {
      const [osInfo, cpuInfo] = await Promise.all([ si.osInfo(), si.cpu() ]);
      _statusCache = {
        hostname:      os.hostname(),
        platform:      os.platform(),
        os:            osInfo.distro || os.type(),
        osVersion:     osInfo.release  || os.release(),
        arch:          os.arch(),
        cpuModel:      cpuInfo.brand   || os.cpus()[0]?.model || "unknown",
        uptimeSeconds: Math.floor(os.uptime()),
      };
      _statusCachedAt = Date.now();
      console.log("[SYSTEM] Status cache warmed up");
    } catch (err) {
      console.warn("[SYSTEM] Pre-warm failed (will retry on first request):", err.message);
    }
  })();
}

// ---------------------------------------------------------------------------
// GET /api/v1/system/status
// ---------------------------------------------------------------------------
export async function getSystemStatus(req, res) {
  try {
    const now = Date.now();
    if (_statusCache && (now - _statusCachedAt) < CACHE_TTL_MS) {
      return res.json({ success: true, data: _statusCache });
    }

    const [osInfo, cpuInfo] = await Promise.all([
      si.osInfo(),
      si.cpu(),
    ]);

    _statusCache = {
      hostname:     os.hostname(),
      platform:     os.platform(),
      os:           osInfo.distro || os.type(),
      osVersion:    osInfo.release  || os.release(),
      arch:         os.arch(),
      cpuModel:     cpuInfo.brand   || os.cpus()[0]?.model || "unknown",
      uptimeSeconds: Math.floor(os.uptime()),
    };
    _statusCachedAt = Date.now();

    return res.json({ success: true, data: _statusCache });
  } catch (err) {
    console.error("[SYSTEM] getSystemStatus error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to retrieve system status" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/system/metrics
// ---------------------------------------------------------------------------
export async function getSystemMetrics(req, res) {
  try {
    const now = Date.now();
    if (_metricsCache && (now - _metricsCachedAt) < CACHE_TTL_MS) {
      return res.json({ success: true, data: _metricsCache });
    }

    const [load, mem] = await Promise.all([
      si.currentLoad(),
      si.mem(),
    ]);

    const totalRam   = mem.total;
    const freeRam    = mem.available;
    const usedRam    = totalRam - freeRam;
    const ramUsedPct = totalRam > 0
      ? Math.round((usedRam / totalRam) * 1000) / 10
      : 0;
    const cpuUsedPct = Math.round(load.currentLoad * 10) / 10;

    _metricsCache = {
      cpu: { usagePercent: cpuUsedPct },
      ram: {
        totalBytes:  totalRam,
        freeBytes:   freeRam,
        usedBytes:   usedRam,
        usedPercent: ramUsedPct,
        totalGb: Math.round(totalRam / 1073741824 * 100) / 100,
        freeGb:  Math.round(freeRam  / 1073741824 * 100) / 100,
        usedGb:  Math.round(usedRam  / 1073741824 * 100) / 100,
      },
    };
    _metricsCachedAt = Date.now();

    return res.json({ success: true, data: _metricsCache });
  } catch (err) {
    console.error("[SYSTEM] getSystemMetrics error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to retrieve system metrics" });
  }
}
