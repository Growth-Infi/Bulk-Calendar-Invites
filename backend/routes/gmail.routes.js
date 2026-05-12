import express from "express";
import {
  connectGmail,
  gmailCallback,
  getAccounts,
  updateGmailStatus,
  updateDailyLimit,
  disconnectGmailAccount,
} from "../controllers/gmail.controller.js";
import { requireAuth } from "../middleware/auth.js";
const router = express.Router();

router.get("/connect", requireAuth, connectGmail);
router.get("/callback", gmailCallback);
router.get("/accounts", requireAuth, getAccounts); //active or paused
router.patch("/:id/status", requireAuth, updateGmailStatus);
router.patch("/:id/limit", requireAuth, updateDailyLimit);
router.patch("/:id/disconnect", requireAuth, disconnectGmailAccount);

export default router;
