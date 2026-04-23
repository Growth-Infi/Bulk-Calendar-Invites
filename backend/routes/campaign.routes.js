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
const router = express.Router();

router.get("/", getCampaigns);
router.get("/:id/recipients", getCampaignRecipients);
router.get("/:id", getCampaignById);

router.post("/create", createCampaign);
router.patch("/:id/start", startCampaign);
router.patch("/:id/pause", pauseCampaign);
router.patch("/:id/resume", resumeCampaign);

export default router;
