import logger from "./lib/logger.js";
import { emailQueue } from "./lib/queue.js";
import { supabase } from "./lib/supabase.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIN_DELAY = 30 * 1000;
const MAX_DELAY = 90 * 1000;
const BATCH_SIZE = 50;

function getRandomDelay() {
  return MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
}

export const startScheduler = async () => {
  console.log("🚀 Scheduler started...");

  while (true) {
    try {
      const { data: expiredAccounts } = await supabase
        .from("gmail_accounts")
        .select("id")
        .in("status", ["active", "limit_reached"]) // paused are ones paused by user
        .lte(
          "window_start",
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        );
      if (expiredAccounts?.length) {
        await supabase
          .from("gmail_accounts")
          .update({
            status: "active",
            sent_today: 0,
            window_start: new Date().toISOString(),
          })
          .in(
            "id",
            expiredAccounts.map((a) => a.id),
          );
        // console.log(`♻️ Reactivated ${expiredAccounts.length} accounts`);
        logger.info(
          { count: expiredAccounts.length },
          "Accounts reactivated after 24h window",
        );
      }
      const { data: accounts, error } = await supabase
        .from("gmail_accounts")
        .select(
          "id, email, status, sent_today, daily_limit, next_send_at, window_start",
        )
        .eq("status", "active")
        .or(
          `next_send_at.is.null,next_send_at.lte.${new Date().toISOString()}`,
        );

      if (error) {
        logger.error({ err: error }, "DB call failed - Account fetch error");
        // console.error("Account fetch error:", error);
        await sleep(2000);
        continue;
      }

      for (const account of accounts) {
        const now = new Date();

        //  Respect delay
        if (account.next_send_at && new Date(account.next_send_at) > now) {
          continue;
        }

        if (account.sent_today >= account.daily_limit) continue;

        //  Pick ONE campaign via first recipient
        const { data: firstRecipient } = await supabase
          .from("recipients")
          .select("campaign_id")
          .eq("status", "pending")
          .eq("assigned_gmail_account_id", account.id)
          .limit(1)
          .maybeSingle();
        let campaignId = null;

        if (firstRecipient) {
          campaignId = firstRecipient.campaign_id;
        } else {
          const { data: fallback } = await supabase
            .from("recipients")
            .select("campaign_id, campaigns!inner(status)")
            .is("assigned_gmail_account_id", null)
            .eq("status", "pending")
            .eq("campaigns.status", "running")
            .limit(1)
            .maybeSingle();
          if (!fallback) continue;

          campaignId = fallback.campaign_id;
        }

        if (!campaignId) continue;
        // Reassign unassigned (ONLY for campaigns this sender belongs to)

        const { data: unassigned } = await supabase
          .from("recipients")
          .select(
            `
             id,
             campaign_senders!inner(gmail_account_id)
           `,
          )
          .is("assigned_gmail_account_id", null)
          .eq("status", "pending")
          .eq("campaign_id", campaignId)
          .eq("campaign_senders.gmail_account_id", account.id)
          .limit(BATCH_SIZE);

        if (unassigned?.length) {
          const ids = unassigned.map((r) => r.id);

          // Only update rows that are still unassigned
          await supabase
            .from("recipients")
            .update({ assigned_gmail_account_id: account.id })
            .in("id", ids)
            .is("assigned_gmail_account_id", null);

          logger.info(
            { count: ids.length, account: account.email },
            `Reassigned ${ids.length} recipients to ${account.email}`,
          );
        }

        const remainingLimit = account.daily_limit - account.sent_today;

        if (remainingLimit <= 0) continue;
        const currentBatchLimit = Math.min(BATCH_SIZE, remainingLimit);

        //  ATOMIC LOCK & FETCH
        const { data: recipients, error: rpcError } = await supabase.rpc(
          "lock_recipients_for_batch_v2",
          {
            p_campaign_id: campaignId,
            p_account_id: account.id,
            p_limit: currentBatchLimit,
          },
        );

        if (rpcError) {
          logger.error(
            { err: rpcError },
            "RPC call lock_recipients_for_batch_v2 (locking recipeients in batches) error",
          );

          // console.error("RPC error:", rpcError);

          continue;
        }
        // console.log("Response for rpc lock_recipients_for_batch ", recipients);

        // 🔥 THIS FIXES YOUR CRASH
        if (!recipients || recipients.length === 0) {
          continue;
        }

        //  SAFETY CHECK again to make sure only one campaign recipients exist
        const uniqueCampaigns = [
          ...new Set(recipients.map((r) => r.campaign_id)),
        ];
        if (uniqueCampaigns.length > 1) {
          logger.error(" Mixed campaigns detected, skipping batch");

          // console.error("❌ Mixed campaigns detected, skipping batch");
          continue;
        }

        // Create batch
        const { data: batch, error: batchError } = await supabase
          .from("event_batches")
          .insert({
            campaign_id: campaignId,
            gmail_account_id: account.id,
            recipient_count: recipients.length,
          })
          .select()
          .single();

        if (batchError || !batch) {
          logger.error({ err: batchError }, "Batch creation failed");
          // console.error("Batch creation failed:", batchError);
          continue;
        }

        //  Map recipients in batch_recipients
        await supabase.from("batch_recipients").insert(
          recipients.map((r) => ({
            batch_id: batch.id,
            recipient_id: r.id,
          })),
        );

        //  Queue job
        await emailQueue.add(
          "create-event",
          {
            batch_id: batch.id,
          },
          {
            attempts: 4,
            backoff: {
              type: "exponential",
              delay: 3 * 60 * 1000,
            },
            removeOnComplete: { count: 100 },
            removeOnFail: false,
          },
        );

        // Delay next send
        const delay = getRandomDelay();
        const buffer = 10000;

        await supabase
          .from("gmail_accounts")
          .update({
            next_send_at: new Date(Date.now() + delay + buffer),
          })
          .eq("id", account.id);
        logger.info(
          {
            batchId: batch.id,
            accountEmail: account.email,
            recipientCount: recipients.length,
          },
          "Batch queued and email worker should pickup",
        );
        // console.log(`✅ Batched ${recipients.length} for ${account.email}`);
      }
    } catch (error) {
      logger.error({ err: error.message }, "Scheduler loop error");
      // console.error("Scheduler error:", error);
    }

    await sleep(45000);
  }
};

// startScheduler();
