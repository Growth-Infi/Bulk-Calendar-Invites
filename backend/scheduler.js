import { emailQueue } from "./lib/queue.js";
import { supabase } from "./lib/supabase.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIN_DELAY = 30 * 1000; // 30 sec
const MAX_DELAY = 90 * 1000; // 90 sec
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

        // Sender mail not ready yet
        if (account.next_send_at && new Date(account.next_send_at) > now) {
          continue;
        }
        const today = new Date().toDateString();
        const last = account.last_sent_at
          ? new Date(account.last_sent_at).toDateString()
          : null;
        if (last !== today) {
          await supabase
            .from("gmail_accounts")
            .update({ sent_today: 0 })
            .eq("id", account.id);
        }

        if (account.sent_today >= account.daily_limit) {
          continue;
        }

        const { data: recipients } = await supabase
          .from("recipients")
          .select("*")
          .eq("status", "pending")
          .eq("assigned_gmail_account_id", account.id)
          .limit(BATCH_SIZE);

        if (!recipients.length) continue;

        // LOCK all
        const ids = recipients.map((r) => r.id);

        await supabase
          .from("recipients")
          .update({ status: "processing" })
          .in("id", ids)
          .eq("status", "pending");

        // create batch
        const { data: batch } = await supabase
          .from("event_batches")
          .insert({
            campaign_id: recipients[0].campaign_id,
            gmail_account_id: account.id,
            recipient_count: recipients.length,
          })
          .select()
          .single();

        // map recipients
        await supabase.from("batch_recipients").insert(
          recipients.map((r) => ({
            batch_id: batch.id,
            recipient_id: r.id,
          })),
        );

        // queue job
        await emailQueue.add(
          "create-event",
          {
            batch_id: batch.id,
          },
          {
            attempts: 4,
            backoff: {
              type: "exponential",
              delay: 2 * 60 * 1000,
            },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );

        const delay = getRandomDelay();
        const buffer = 2000; // 2 sec safety
        await supabase
          .from("gmail_accounts")
          .update({
            next_send_at: new Date(Date.now() + delay + buffer),
          })
          .eq("id", account.id);
        console.log(
          `Queued 1 email for ${account.email}, next in ${Math.round(
            delay / 1000,
          )}s`,
        );
      }
    } catch (error) {
      console.error("Scheduler error:", error);
    }
    await sleep(3500);
  }
};
