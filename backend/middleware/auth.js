import logger from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";

export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      logger.warn(
        {
          method: req.method,
          url: req.originalUrl,
          ip: req.ip,
        },
        "Missing or malformed authorization header",
      );

      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const token = authHeader.split(" ")[1];

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      logger.warn(
        {
          err: error,
          method: req.method,
          url: req.originalUrl,
          ip: req.ip,
        },
        "Invalid JWT token",
      );

      return res.status(401).json({
        error: "Invalid token",
      });
    }

    req.user = user;

    next();
  } catch (err) {
    logger.error(
      {
        err,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
      },
      "Unhandled error in requireAuth middleware",
    );

    return res.status(500).json({
      error: "Internal server error",
    });
  }
};
