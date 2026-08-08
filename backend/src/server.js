import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool } from "./db.js";
import serversRouter from "./routes/servers.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Health check for the API itself (not the servers being monitored)
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "server-monitor backend running" });
});

// This is the endpoint every collector (Windows or Linux) posts to.
// v0: no auth, no validation yet — we're proving the pipeline works first.
app.post("/api/v1/health", async (req, res) => {
  const {
    serverId,
    hostname,
    os,
    cpuUsage,
    memoryUsage,
    diskUsage,
    uptimeSeconds,
    lastBootTime,
    networkStatus,
    backupStatus,
  } = req.body;

  if (!serverId || !os) {
    return res.status(400).json({ error: "serverId and os are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO health_logs
        (server_id, hostname, os, cpu_usage, memory_usage, disk_usage,
         uptime_seconds, last_boot_time, network_status, backup_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, received_at`,
      [
        serverId,
        hostname,
        os,
        cpuUsage,
        memoryUsage,
        JSON.stringify(diskUsage || []),
        uptimeSeconds,
        lastBootTime,
        networkStatus,
        JSON.stringify(backupStatus || {}),
      ]
    );

    res.status(201).json({ saved: true, id: result.rows[0].id, receivedAt: result.rows[0].received_at });
  } catch (err) {
    console.error("Failed to save health log", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// Returns the most recent reading per server — this is what the dashboard will call
app.get("/api/v1/health", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (server_id) *
       FROM health_logs
       ORDER BY server_id, received_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch health logs", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// Server inventory management (add/edit/remove servers)
   app.use("/api/v1/servers", serversRouter);

// Returns full history for one server — useful later for graphs
app.get("/api/v1/health/:serverId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM health_logs WHERE server_id = $1 ORDER BY received_at DESC LIMIT 100`,
      [req.params.serverId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch server history", err);
    res.status(500).json({ error: "internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`server-monitor backend listening on http://localhost:${PORT}`);
});
