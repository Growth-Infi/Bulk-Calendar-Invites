import express from "express";
import dotenv from "dotenv";
import gmailRoutes from "./routes/gmail.routes.js";
import campaignRoutes from "./routes/campaign.routes.js";
import "./config.js";
// import { startScheduler } from "./scheduler.js";
import cors from "cors";
import { requestLogger } from "./middleware/requestLogger.js";

import helmet from "helmet";
import rateLimit from "express-rate-limit";
// import "./workers/email.worker.js";
dotenv.config();

const app = express();
app.use(requestLogger);

app.use(express.json());

app.use(helmet());

// Tighter limit on auth-adjacent routes
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: { error: "Too many requests" },
});
app.use(cors());
// app.use(
//   cors({
//     origin: process.env.FRONTEND_URL,
//     credentials: true,
//   }),
// );
app.use("/gmail", authLimiter, gmailRoutes);
app.use("/campaign", campaignRoutes);

// startScheduler();
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok - GrowthInfi Calendar Invites",
    service: "GrowthInfi Calendar Invites",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
app.listen(5000, () => {
  console.log("Server running on port 5000");
});
