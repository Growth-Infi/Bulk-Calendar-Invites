import express from "express";
import dotenv from "dotenv";
import gmailRoutes from "./routes/gmail.routes.js";
import campaignRoutes from "./routes/campaign.routes.js";
import "./config.js";
import { startScheduler } from "./scheduler.js";
import cors from "cors";
// import "./workers/email.worker.js";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
// app.use(
//   cors({
//     origin: process.env.FRONTEND_URL,
//     credentials: true,
//   }),
// );
app.use("/gmail", gmailRoutes);
app.use("/campaign", campaignRoutes);

startScheduler();
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "email-api",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
app.listen(5000, () => {
  console.log("Server running on port 5000");
});
