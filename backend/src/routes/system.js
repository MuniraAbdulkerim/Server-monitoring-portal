/**
 * System metrics routes — reports the health of the backend host machine.
 *
 * GET /api/v1/system/status   — hostname, OS, uptime
 * GET /api/v1/system/metrics  — CPU %, RAM total/free/used
 *
 * Both endpoints require a valid dashboard JWT (requireUser).
 * They do NOT require admin role — any authenticated user may view them.
 */
import express from "express";
import { requireUser } from "../middleware/requireUser.js";
import { getSystemStatus, getSystemMetrics } from "../controllers/systemController.js";

const router = express.Router();

// GET /api/v1/system/status
router.get("/status",  requireUser, getSystemStatus);

// GET /api/v1/system/metrics
router.get("/metrics", requireUser, getSystemMetrics);

export default router;
