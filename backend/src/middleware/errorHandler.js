/**
 * Centralized Express error handler.
 * Must be registered LAST with app.use().
 */

const IS_PROD = process.env.NODE_ENV === "production";

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Zod validation errors (Zod v4 uses err.issues; v3 used err.errors)
  if (err.name === "ZodError") {
    const issues = err.issues ?? err.errors ?? [];
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: issues.map((e) => ({
        field: Array.isArray(e.path) ? e.path.join(".") : String(e.path ?? ""),
        message: e.message,
      })),
    });
  }

  // Known HTTP errors (thrown with err.status)
  if (err.status) {
    return res.status(err.status).json({
      success: false,
      message: err.message || "Request failed",
    });
  }

  // Unexpected errors
  const status = err.status || 500;
  console.error("[ERROR]", err);

  return res.status(status).json({
    success: false,
    message: IS_PROD ? "Internal server error" : (err.message || "Internal server error"),
  });
}
