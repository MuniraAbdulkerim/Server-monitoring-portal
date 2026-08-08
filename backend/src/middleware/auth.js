/**
 * Checks for a valid Bearer token on incoming requests.
 *
 * Usage: every collector (agent) must send this header:
 *   Authorization: Bearer <AGENT_API_TOKEN>
 */
export function requireAgentToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header. Expected: Bearer <token>" });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  if (token !== process.env.AGENT_API_TOKEN) {
    return res.status(403).json({ error: "Invalid agent token" });
  }

  next();
}