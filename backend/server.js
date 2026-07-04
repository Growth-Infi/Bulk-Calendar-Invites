import express from "express";
import dotenv from "dotenv";
import gmailRoutes from "./routes/gmail.routes.js";
import campaignRoutes from "./routes/campaign.routes.js";
import "./config.js";
import cors from "cors";
import { requestLogger } from "./middleware/requestLogger.js";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
dotenv.config();

const app = express();
app.use(requestLogger);
app.set("trust proxy", 1);
app.use(express.json());
app.use(helmet());

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: { error: "Too many requests" },
});
app.use(cors());

app.use("/gmail", authLimiter, gmailRoutes);
app.use("/campaign", campaignRoutes);

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok - GrowthInfi Calendar Invites",
    service: "GrowthInfi Calendar Invites",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.listen(process.env.PORT || 5000, () => {
  console.log("Server running");
});
