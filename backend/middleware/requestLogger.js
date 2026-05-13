import logger from "../lib/logger.js";

export const requestLogger = (req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.info({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
      userId: req.user?.id ?? null,
    });
  });
  next();
};
