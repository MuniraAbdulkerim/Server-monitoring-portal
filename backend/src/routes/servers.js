import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// GET /api/v1/servers — list all registered servers
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM servers ORDER BY name ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch servers", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// POST /api/v1/servers — register a new server
router.post("/", async (req, res) => {
  const { serverId, name, ipOrHostname, serverType, os, location, criticality, owner } = req.body;

  if (!serverId || !name) {
    return res.status(400).json({ error: "serverId and name are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO servers (server_id, name, ip_or_hostname, server_type, os, location, criticality, owner)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [serverId, name, ipOrHostname, serverType, os, location, criticality || "medium", owner]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: `A server with serverId "${serverId}" already exists` });
    }
    console.error("Failed to create server", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// PUT /api/v1/servers/:serverId — edit an existing server's details
router.put("/:serverId", async (req, res) => {
  const { name, ipOrHostname, serverType, os, location, criticality, owner } = req.body;

  try {
    const result = await pool.query(
      `UPDATE servers
       SET name = COALESCE($1, name),
           ip_or_hostname = COALESCE($2, ip_or_hostname),
           server_type = COALESCE($3, server_type),
           os = COALESCE($4, os),
           location = COALESCE($5, location),
           criticality = COALESCE($6, criticality),
           owner = COALESCE($7, owner),
           updated_at = now()
       WHERE server_id = $8
       RETURNING *`,
      [name, ipOrHostname, serverType, os, location, criticality, owner, req.params.serverId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "server not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Failed to update server", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// DELETE /api/v1/servers/:serverId — remove a server from inventory
router.delete("/:serverId", async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM servers WHERE server_id = $1 RETURNING server_id`,
      [req.params.serverId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "server not found" });
    }
    res.json({ deleted: true, serverId: result.rows[0].server_id });
  } catch (err) {
    console.error("Failed to delete server", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;