/**
 * Alerts routes.
 *
 * GET  /api/v1/alerts           — active (unresolved) alerts
 * GET  /api/v1/alerts?all=true  — all alerts including resolved
 * PUT  /api/v1/alerts/:id/resolve — manually resolve an alert
 */
import express from "express";
import { pool } from "../db.js";
import { requireRole } from "../middleware/requireUser.js";

const router = express.Router();

// GET /api/v1/alerts
router.get("/", async (req, res, next) => {
  try {
    const query =
      req.query.all === "true"
        ? `SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200`
        : `SELECT * FROM alerts WHERE resolved = false ORDER BY created_at DESC`;

    const { rows } = await pool.query(query);
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/alerts/:id/resolve  — manually acknowledge/resolve  [admin only]
router.put("/:id/resolve", requireRole("admin"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: "Invalid alert id" });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE alerts
       SET resolved = true, resolved_at = now()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Alert not found" });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
