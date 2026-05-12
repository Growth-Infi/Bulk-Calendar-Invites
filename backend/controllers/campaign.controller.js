import { supabase } from "../lib/supabase.js";
import { assignRecipients } from "../services/assignment.service.js";
import { emailQueue } from "../lib/queue.js";

export const getCampaigns = async (req, res) => {
  try {
    const user_id = req.user.id;

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    // Call the RPC function
    const { data, error } = await supabase.rpc("get_campaigns_with_stats", {
      p_user_id: user_id,
    });

    if (error) {
      console.error("RPC Error:", error);
      return res.status(500).json({ error: error.message });
    }

    // data is already formatted as an array of objects with total_recipients and sent_count
    return res.json(data);
  } catch (err) {
    console.error("Get Campaigns Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getCampaignById = async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.id;

    if (!id || !user_id) {
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
      return res.status(404).json({ error: "Campaign not found" });
    }

    return res.json(data);
  } catch (err) {
    console.error("Get Campaign By ID Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getCampaignRecipients = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        error: "campaign id is required",
      });
    }

    const { data, error } = await supabase
      .from("recipients")
      .select(
        `id,
        email,
        status,
        error,
        assigned_gmail_account_id,
        gmail_accounts!assigned_gmail_account_id(email)`,
      )
      .eq("campaign_id", id)
      .order("created_at", { ascending: false });
    // console.log("Data for recipients ", data);

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    const formattedData = data.map((r) => ({
      ...r,
      sender_email: r.gmail_accounts?.email || "Not Assigned",
    }));
    return res.json(formattedData);
  } catch (err) {
    console.error("Get Campaign Recipients Error:", err);
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

    const rows = emails.map((email) => ({
      campaign_id: campaign.id,
      email: email.trim(),
    }));

    const { error: recError } = await supabase.from("recipients").insert(rows);

    if (recError) {
      console.error("Recipients insert error:", recError);
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
      console.error("Campaign senders insert error:", senderError);
      throw senderError;
    }

    res.json(campaign);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Create failed" });
  }
};

export const startCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.id;

    if (!id || !user_id) {
      return res.status(400).json({
        error: "campaign id and user_id are required",
      });
    }

    const { data: campaign, error: updateError } = await supabase
      .from("campaigns")
      .update({ status: "running" })
      .eq("id", id)
      // .eq("status", "draft") // Atomic check: only update if it was a draft
      .select()
      .single();

    if (!campaign)
      return res
        .status(404)
        .json({ error: "Campaign not found or already running" });

    // if (campaign.status === "running") {
    //   return res.status(400).json({ error: "Campaign already running" });
    // }

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    //  assign sender emails to recipoents
    await assignRecipients(id, user_id);

    return res.json({
      message: "Campaign started. Scheduler will handle sending.",
    });
  } catch (err) {
    console.error("Start Campaign Error:", err);
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

    return res.json({ message: "Campaign paused" });
  } catch (err) {
    console.error("Pause Campaign Error:", err);
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

    return res.json({ message: "Campaign resumed" });
  } catch (err) {
    console.error("Resume Campaign Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
