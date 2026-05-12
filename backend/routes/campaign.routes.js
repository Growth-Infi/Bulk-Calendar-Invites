import express from "express";
import {
  createCampaign,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  getCampaigns,
  getCampaignRecipients,
  getCampaignById,
} from "../controllers/campaign.controller.js";
import { requireAuth } from "../middleware/auth.js";
const router = express.Router();

router.get("/", requireAuth, getCampaigns);
router.get("/:id/recipients", requireAuth, getCampaignRecipients);
router.get("/:id", requireAuth, getCampaignById);

router.post("/create", requireAuth, createCampaign);
router.patch("/:id/start", requireAuth, startCampaign);
router.patch("/:id/pause", requireAuth, pauseCampaign);
router.patch("/:id/resume", requireAuth, resumeCampaign);

export default router;
