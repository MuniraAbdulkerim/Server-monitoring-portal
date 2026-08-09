import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// GET /api/v1/alerts — active (unresolved) alerts by default
// GET /api/v1/alerts?all=true — include resolved ones too
router.get("/", async (req, res) => {
  try {
    const query = req.query.all === "true"
      ? `SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200`
      : `SELECT * FROM alerts WHERE resolved = false ORDER BY created_at DESC`;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch alerts", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;