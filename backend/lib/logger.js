import pino from "pino";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVICE_NAME = process.env.SERVICE_NAME || "app";
const LOG_DIR = path.join(__dirname, "../logs");

const isDev = process.env.NODE_ENV !== "production";

const transport = isDev
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
      },
    }
  : {
      targets: [
        // IMPORTANT:  captures stdout
        {
          target: "pino/file",
          options: {
            destination: 1,
          },
        },

        // All logs file
        {
          target: "pino/file",
          options: {
            destination: `${LOG_DIR}/${SERVICE_NAME}.log`,
            mkdir: true,
          },
        },

        // Error-only file
        {
          target: "pino/file",
          level: "error",
          options: {
            destination: `${LOG_DIR}/${SERVICE_NAME}.error.log`,
            mkdir: true,
          },
        },
      ],
    };

const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    base: {
      pid: process.pid,
      env: process.env.NODE_ENV,
      service: SERVICE_NAME,
    },

    timestamp: pino.stdTimeFunctions.isoTime,

    redact: {
      paths: ["*.access_token", "*.refresh_token", "req.headers.authorization"],
      censor: "[REDACTED]",
    },
  },
  pino.transport(transport),
);

export default logger;
