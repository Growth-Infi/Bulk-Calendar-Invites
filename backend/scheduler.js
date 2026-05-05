import { emailQueue } from "./lib/queue.js";
import { supabase } from "./lib/supabase.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIN_DELAY = 30 * 1000;
const MAX_DELAY = 90 * 1000;
const BATCH_SIZE = 20;

function getRandomDelay() {
  return MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
}

export const startScheduler = async () => {
  console.log("🚀 Scheduler started...");

  while (true) {
    try {
      const { data: accounts, error } = await supabase
        .from("gmail_accounts")
        .select("*")
        .eq("status", "active")
        .or(
          `next_send_at.is.null,next_send_at.lte.${new Date().toISOString()}`,
        );

      if (error) {
        console.error("Account fetch error:", error);
        await sleep(2000);
        continue;
      }

      for (const account of accounts) {
        const now = new Date();

        // ⏱ Respect delay
        if (account.next_send_at && new Date(account.next_send_at) > now) {
          continue;
        }

        // 🔄 Reset daily counter
        const today = new Date().toDateString();
        const last = account.last_sent_at
          ? new Date(account.last_sent_at).toDateString()
          : null;

        if (last !== today) {
          await supabase
            .from("gmail_accounts")
            .update({ sent_today: 0 })
            .eq("id", account.id);
          account.sent_today = 0;
        }

        if (account.sent_today >= account.daily_limit) {
          continue;
        }

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
            .select("campaign_id")
            .is("assigned_gmail_account_id", null)
            .eq("status", "pending")
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

          await supabase
            .from("recipients")
            .is("assigned_gmail_account_id", null)
            .update({ assigned_gmail_account_id: account.id })
            .in("id", ids);

          console.log(
            `♻️ Reassigned ${ids.length} recipients to ${account.email}`,
          );
        }

        const remainingLimit = account.daily_limit - account.sent_today;

        if (remainingLimit <= 0) continue;
        const currentBatchLimit = Math.min(BATCH_SIZE, remainingLimit);

        // 3. ATOMIC LOCK & FETCH (The RPC Replacement)
        // This replaces the old Step 3 and Step 4
        const { data: recipients, error: rpcError } = await supabase.rpc(
          "lock_recipients_for_batch",
          {
            p_campaign_id: campaignId,
            p_account_id: account.id,
            p_limit: currentBatchLimit,
          },
        );

        if (rpcError) {
          console.error("RPC error:", rpcError);
          continue;
        }
        console.log("Response for rpc lock_recipients_for_batch ", recipients);

        // 🔥 THIS FIXES YOUR CRASH
        if (!recipients || recipients.length === 0) {
          continue;
        }

        //  SAFETY CHECK again to make sure only one campaign recipients exist
        const uniqueCampaigns = [
          ...new Set(recipients.map((r) => r.campaign_id)),
        ];
        if (uniqueCampaigns.length > 1) {
          console.error("❌ Mixed campaigns detected, skipping batch");
          continue;
        }

        // 🔹 STEP 5: Create batch
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
          console.error("Batch creation failed:", batchError);
          continue;
        }

        // 🔹 STEP 6: Map recipients
        await supabase.from("batch_recipients").insert(
          recipients.map((r) => ({
            batch_id: batch.id,
            recipient_id: r.id,
          })),
        );

        // 🔹 STEP 7: Queue job
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
            removeOnComplete: true,
            removeOnFail: false,
          },
        );

        // 🔹 STEP 8: Delay next send
        const delay = getRandomDelay();
        const buffer = 2000;

        await supabase
          .from("gmail_accounts")
          .update({
            next_send_at: new Date(Date.now() + delay + buffer),
          })
          .eq("id", account.id);

        console.log(`✅ Batched ${recipients.length} for ${account.email}`);
      }
    } catch (error) {
      console.error("Scheduler error:", error);
    }

    await sleep(3500);
  }
};
