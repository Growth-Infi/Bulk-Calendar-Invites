import { supabase } from "../lib/supabase.js";
import { assignRecipients } from "../services/assignment.service.js";
import { emailQueue } from "../lib/queue.js";
import logger from "../lib/logger.js";

export const getCampaignStats = async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase.rpc("get_campaign_stats", {
      p_campaign_id: id,
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.json(data);
  } catch (err) {
    logger.error(
      { err, campaignId: req.params.id },
      "Unhandled error in getCampaignStats",
    );
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getCampaigns = async (req, res) => {
  try {
    const user_id = req.user.id;

    if (!user_id) {
      logger.warn({ userId: user_id }, "Missing user_id in getCampaigns");
      return res.status(400).json({ error: "user_id is required" });
    }

    // Call the RPC function
    const { data, error } = await supabase.rpc("get_campaigns_with_stats", {
      p_user_id: user_id,
    });

    if (error) {
      logger.error(
        {
          err: error,
          userId: user_id,
        },
        "Failed to fetch campaigns via RPC",
      );
      // console.error("RPC Error:", error);

      return res.status(500).json({ error: error.message });
    }

    // data is already formatted as an array of objects with total_recipients and sent_count
    logger.info(
      {
        userId: user_id,
        campaignsCount: data?.length || 0,
      },
      "Campaigns fetched successfully",
    );

    return res.json(data);
  } catch (err) {
    logger.error(
      { err, userId: req.user?.id },
      "Unhandled error in getCampaigns",
    );
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getCampaignById = async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.id;

    if (!id || !user_id) {
      logger.warn(
        {
          campaignId: id,
          userId: user_id,
        },
        "Missing campaign id or user_id",
      );

      return res.status(400).json({
        error: "campaign id and user_id are required",
      });
    }

    const { data, error } = await supabase
      .from("campaigns")
      .select(
        `
     *,
    recipients(count)
     `,
      )
      .eq("id", id)
      .eq("user_id", user_id)
      .single();
    if (error || !data) {
      logger.warn(
        {
          campaignId: id,
          userId: user_id,
        },
        "Campaign not found",
      );
      return res.status(404).json({ error: "Campaign not found" });
    }
    logger.info(
      {
        campaignId: id,
        userId: user_id,
      },
      "Campaign fetched successfully",
    );
    return res.json(data);
  } catch (err) {
    logger.error(
      {
        err,
        campaignId: req.params.id,
        userId: req.user?.id,
      },
      "Unhandled error in getCampaignById",
    );
    // console.error("Get Campaign By ID Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getCampaignRecipients = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    if (!id) {
      logger.warn("Campaign id missing while fetching recipients");
      return res.status(400).json({ error: "campaign id is required" });
    }

    const { data, error, count } = await supabase
      .from("recipients")
      .select(
        `id, email, status, error, assigned_gmail_account_id,
        gmail_accounts!assigned_gmail_account_id(email)`,
        { count: "exact" },
      )
      .eq("campaign_id", id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error(
        { err: error, campaignId: id },
        "Failed to fetch campaign recipients",
      );
      return res.status(500).json({ error: error.message });
    }

    const formattedData = data.map((r) => ({
      ...r,
      sender_email: r.gmail_accounts?.email || "Not Assigned",
    }));

    return res.json({ data: formattedData, total: count, limit, offset });
  } catch (err) {
    logger.error(
      { err, campaignId: req.params.id },
      "Unhandled error in getCampaignRecipients",
    );
    return res.status(500).json({ error: "Internal server error" });
  }
};
export const createCampaign = async (req, res) => {
  try {
    const {
      name,
      event_title,
      meeting_link,
      start_time,
      end_time,
      timezone,
      description,
      emails,
      sender_ids,
    } = req.body;
    const user_id = req.user.id;

    if (
      !user_id ||
      !event_title ||
      !meeting_link ||
      !start_time ||
      !end_time ||
      !timezone ||
      !emails?.length ||
      !sender_ids?.length
    ) {
      logger.warn(
        {
          userId: user_id,
        },
        "Missing required fields while creating campaign",
      );
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { data: campaign, error } = await supabase
      .from("campaigns")
      .insert([
        {
          user_id,
          name,
          event_title,
          meeting_link,
          start_time,
          end_time,
          timezone,
          description,
          status: "draft",
        },
      ])
      .select()
      .single();

    if (error) throw error;
    logger.info(
      {
        campaignId: campaign.id,
        userId: user_id,
      },
      "Campaign created",
    );

    const rows = emails.map((email) => ({
      campaign_id: campaign.id,
      email: email.trim(),
    }));

    const { error: recError } = await supabase.from("recipients").insert(rows);

    if (recError) {
      // console.error("Recipients insert error:", recError);
      logger.error(
        {
          err: recError,
          campaignId: campaign.id,
        },
        "Failed to insert recipients",
      );
      throw recError;
    }

    const { error: senderError } = await supabase
      .from("campaign_senders")
      .insert(
        sender_ids.map((id) => ({
          campaign_id: campaign.id,
          gmail_account_id: id,
        })),
      );

    if (senderError) {
      // console.error("Campaign senders insert error:", senderError);
      logger.error(
        {
          err: senderError,
          campaignId: campaign.id,
        },
        "Failed to insert campaign senders",
      );
      throw senderError;
    }

    logger.info(
      {
        campaignId: campaign.id,
        recipients: emails.length,
        senders: sender_ids.length,
      },
      "Campaign setup completed",
    );
    res.json(campaign);
  } catch (err) {
    // console.error(err);

    logger.error(
      {
        err,
        userId: req.user?.id,
      },
      "Unhandled error in createCampaign",
    );
    res.status(500).json({ error: "Create failed" });
  }
};

export const startCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.id;

    if (!id || !user_id) {
      logger.warn(
        { campaignId: id, userId: user_id },
        "Missing campaign id or user_id in startCampaign",
      );
      return res
        .status(400)
        .json({ error: "campaign id and user_id are required" });
    }

    const { data: campaign, error: updateError } = await supabase
      .from("campaigns")
      .update({ status: "running" })
      .eq("id", id)
      // .eq("status", "draft")
      .select()
      .single();

    // if (campaign.status === "running") {
    //   return res.status(400).json({ error: "Campaign already running" });
    // }

    if (updateError) {
      logger.error(
        { err: updateError, campaignId: id, userId: user_id },
        "Failed to update campaign status to running",
      );
      return res.status(500).json({ error: updateError.message });
    }

    if (!campaign) {
      logger.warn(
        { campaignId: id, userId: user_id },
        "Campaign not found or already running",
      );
      return res
        .status(404)
        .json({ error: "Campaign not found or already running" });
    }

    logger.info(
      {
        campaignId: id,
        userId: user_id,
      },
      "Starting recipient assignment",
    );
    //  assign sender emails to recipoents
    await assignRecipients(id, user_id);
    logger.info(
      {
        campaignId: id,
        userId: user_id,
      },
      "Campaign started successfully",
    );
    return res.json({
      message: "Campaign started. Scheduler will handle sending.",
    });
  } catch (err) {
    // console.error("Start Campaign Error:", err);
    logger.error(
      {
        err,
        campaignId: req.params.id,
        userId: req.user?.id,
      },
      "Unhandled error in startCampaign",
    );
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const pauseCampaign = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "Campaign id is required" });
    }

    const { data: campaign, error: fetchError } = await supabase
      .from("campaigns")
      .select("status")
      .eq("id", id)
      .single();

    if (fetchError || !campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaign.status !== "running") {
      return res.status(400).json({
        error: "Only running campaigns can be paused",
      });
    }

    const { error } = await supabase
      .from("campaigns")
      .update({ status: "paused" })
      .eq("id", id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    logger.info(
      {
        campaignId: id,
      },
      "Campaign paused",
    );
    return res.json({ message: "Campaign paused" });
  } catch (err) {
    // console.error("Pause Campaign Error:", err);
    logger.error(
      {
        err,
        campaignId: req.params.id,
      },
      "Unhandled error in pauseCampaign",
    );
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const resumeCampaign = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "Campaign id is required" });
    }

    const { data: campaign, error: fetchError } = await supabase
      .from("campaigns")
      .select("status")
      .eq("id", id)
      .single();

    if (fetchError || !campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaign.status !== "paused") {
      return res.status(400).json({
        error: "Only paused campaigns can be resumed",
      });
    }

    const { error } = await supabase
      .from("campaigns")
      .update({ status: "running" })
      .eq("id", id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    logger.info(
      {
        campaignId: id,
      },
      "Campaign resumed",
    );
    return res.json({ message: "Campaign resumed" });
  } catch (err) {
    // console.error("Resume Campaign Error:", err);

    logger.error(
      {
        err,
        campaignId: req.params.id,
      },
      "Unhandled error in resumeCampaign",
    );
    return res.status(500).json({ error: "Internal server error" });
  }
};
