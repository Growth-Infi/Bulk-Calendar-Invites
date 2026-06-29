import logger from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";

export const assignRecipients = async (campaign_id, user_id) => {
  try {
    logger.info(
      {
        campaignId: campaign_id,
        userId: user_id,
      },
      "Starting recipient assignment",
    );

    const { data, error: accError } = await supabase
      .from("campaign_senders")
      .select(
        `
        gmail_account:gmail_account_id (*)
      `,
      )
      .eq("campaign_id", campaign_id);

    if (accError) {
      logger.error(
        {
          err: accError,
          campaignId: campaign_id,
          userId: user_id,
        },
        "Failed to fetch campaign sender accounts",
      );

      throw accError;
    }

    const accounts = data
      .map((d) => d.gmail_account)
      .filter((a) => a.status === "active");

    if (!accounts || accounts.length === 0) {
      logger.warn(
        {
          campaignId: campaign_id,
          userId: user_id,
        },
        "No active Gmail accounts found for campaign",
      );

      throw new Error("No Gmail accounts found for this user");
    }

    logger.info(
      {
        campaignId: campaign_id,
        activeAccounts: accounts.length,
      },
      "Active Gmail accounts fetched",
    );

    const { data: recipients, error: recError } = await supabase
      .from("recipients")
      .select("id,email")
      .eq("campaign_id", campaign_id);

    if (recError) {
      logger.error(
        {
          err: recError,
          campaignId: campaign_id,
        },
        "Failed to fetch recipients",
      );

      throw recError;
    }

    if (!recipients.length) {
      logger.warn(
        {
          campaignId: campaign_id,
        },
        "No recipients found for campaign",
      );

      return;
    }

    logger.info(
      {
        campaignId: campaign_id,
        recipientsCount: recipients.length,
      },
      "Recipients fetched successfully",
    );

    const updates = recipients.map((r, i) => ({
      id: r.id,
      email: r.email,
      assigned_gmail_account_id: accounts[i % accounts.length].id,
      campaign_id: campaign_id,
    }));

    const chunkSize = 200;

    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);

      const { error: upsertError } = await supabase
        .from("recipients")
        .upsert(chunk, { onConflict: "id", returning: "minimal" });

      if (upsertError) {
        logger.error(
          {
            err: upsertError,
            campaignId: campaign_id,
            failedChunkStartIndex: i,
          },
          "Failed recipient assignment chunk upsert",
        );

        throw upsertError;
      }

      logger.info(
        {
          campaignId: campaign_id,
          processed: i + chunk.length,
          total: updates.length,
        },
        "Recipient assignment chunk processed",
      );
    }

    logger.info(
      {
        campaignId: campaign_id,
        assignedRecipients: updates.length,
        senderAccounts: accounts.length,
      },
      "Recipient assignment completed successfully",
    );
  } catch (err) {
    logger.error(
      {
        err,
        campaignId: campaign_id,
        userId: user_id,
      },
      "Unhandled error in assignRecipients",
    );

    throw err;
  }
};
