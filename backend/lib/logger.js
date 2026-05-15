import pino from "pino";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_DIR = path.join(__dirname, "../logs");
// const LOG_DIR = path.join(__dirname, "../../logs");
const isDev = process.env.NODE_ENV !== "production";

const transport = isDev
  ? { target: "pino-pretty", options: { colorize: true } }
  : {
      targets: [
        {
          target: "pino/file",
          options: { destination: `${LOG_DIR}/app.log`, mkdir: true },
        },
        // errors also get their own file for easy grep
        {
          target: "pino/file",
          level: "error",
          options: { destination: `${LOG_DIR}/error.log`, mkdir: true },
        },
      ],
    };

const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",

    serializers: {
      err: pino.stdSerializers.err,
    },

    base: {
      pid: process.pid,
      env: process.env.NODE_ENV,
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
