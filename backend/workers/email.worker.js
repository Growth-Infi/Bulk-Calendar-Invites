import "../config.js";
import { supabase } from "../lib/supabase.js";
import { createCalendarEvent } from "../services/sender.service.js";
import { connection } from "../lib/queue.js";
import { tryCatch, Worker } from "bullmq";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isRetryableError = (error) => {
  const status = error.response?.status || error.code;
  const reason = error.response?.data?.error?.errors?.[0]?.reason;

  // NOT DONE if 403: Rate Limit Exceeded rateLimitExceeded errors can return either 403 or 429 error
  // codes—currently they are functionally similar and should be responded to in the same way,
  // by using exponential backoff. Additionally make sure your app follows best practices from manage quotas.
  const retryableStatuses = [429, 500, 502, 503, 504];
  const retryableCodes = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"];
  const retryableReasons = [
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "backendError",
  ];

  return (
    retryableStatuses.includes(status) ||
    retryableCodes.includes(error.code) ||
    retryableReasons.includes(reason)
  );
};

console.log("🚀 Email Worker starting...");
console.log("REDIS_URL:", process.env.REDIS_URL ? "✅ Present" : "❌ Missing");

const worker = new Worker(
  "email-queue",
  async (job) => {
    const { batch_id } = job.data;

    const { data: batch, error: fetchError } = await supabase
      .from("event_batches")
      .select(
        `
      *,
      campaign:campaign_id (*),
      account:gmail_account_id (*),
      recipients:batch_recipients (
        recipient_id,
        recipients ( email )
      )
    `,
      )
      .eq("id", batch_id)
      .single();
    if (fetchError || !batch) throw new Error("Batch data not found");

    const { account, campaign } = batch;
    const emails = batch.recipients.map((r) => r.recipients.email);
    const recipient_ids = batch.recipients.map((r) => r.recipient_id);

    if (campaign.status !== "running") {
      console.log(` Campaign paused. Skipping batch ${batch_id}`);

      await supabase
        .from("event_batches")
        .update({ status: "cancelled" })
        .eq("id", batch_id);

      await supabase
        .from("recipients")
        .update({
          status: "pending",
        })
        .in("id", recipient_ids);

      return;
    }
    if (!account || account.status !== "active") {
      console.warn(
        `🛑 Account ${account?.email} is ${account?.status}. Marking batch as failed and exiting.`,
      );

      await supabase
        .from("event_batches")
        .update({ status: "cancelled" })
        .eq("id", batch_id);

      await supabase
        .from("recipients")
        .update({
          status: "pending",
          assigned_gmail_account_id: null,
        })
        .in("id", recipient_ids);
      return;
    }

    try {
      console.log({
        start: campaign.start_time,
        end: campaign.end_time,
        tz: campaign.timezone,
      });
      const eventId = await createCalendarEvent(account, campaign, emails);
      const { data: success, error: rpcError } = await supabase.rpc(
        "increment_account_sent_safe",
        {
          account_id: account.id,
          amount: emails.length,
        },
      );

      if (!success || rpcError) {
        // This means the event was sent, but we've hit/exceeded our limit
        console.warn(
          `⚠️ Limit reached for ${account.email}. Tagging account for review.`,
        );

        // Set status to 'paused' so the scheduler skips it in the next loop
        await supabase
          .from("gmail_accounts")
          .update({ status: "paused" })
          .eq("id", account.id);
      }
      await supabase
        .from("event_batches")
        .update({
          google_event_id: eventId,
          status: "created",
        })
        .eq("id", batch_id);

      await supabase
        .from("recipients")
        .update({ status: "invited" })
        .in("id", recipient_ids);

      const { count } = await supabase
        .from("recipients")
        .select("*", { count: "exact", head: true })
        .eq("campaign_id", campaign.id)
        .in("status", ["pending", "processing"]);

      if (count === 0) {
        await supabase
          .from("campaigns")
          .update({ status: "completed" })
          .eq("id", campaign.id);

        console.log(`🎉 Campaign ${campaign.id} completed`);
      }
    } catch (err) {
      if (isRetryableError(err)) {
        throw err; // retry via BullMQ
      }

      const isAuthError =
        err.response?.status === 401 ||
        err.response?.data?.error?.message === "Invalid Credentials";

      if (isAuthError) {
        await supabase
          .from("recipients")
          .update({
            status: "pending",
            assigned_gmail_account_id: null,
          })
          .in("id", recipient_ids);

        await supabase
          .from("gmail_accounts")
          .update({ status: "needs_reauth" })
          .eq("id", account.id);

        console.warn(`🔴 Account ${account.email} blocked due to auth error`);
      } else {
        //  Permanent failure (bad emails, invalid request, etc.)
        const status = err.response?.status || err.code;
        const customErrorMsg = status + " - " + err.message;

        await supabase
          .from("recipients")
          .update({
            status: "failed",
            error: customErrorMsg,
          })
          .in("id", recipient_ids);

        console.warn(`❌ Permanent failure for batch ${batch_id}`);
      }

      // mark batch failed
      await supabase
        .from("event_batches")
        .update({ status: "failed" })
        .eq("id", batch_id);
    }
  },
  { connection },
);
worker.on("ready", () => {
  console.log("🟢 Worker connected to Redis and ready");
});

worker.on("error", (err) => {
  console.error("🔴 Worker connection error:", err);
});

worker.on("failed", (job, err) => {
  console.error(
    `❌ Job ${job.id} permanently failed after all retries:`,
    err.message,
  );
  // const { batch_id } = job.data;
  // Final safety net: Release recipients so they aren't stuck in 'processing' forever
  // await supabase.rpc("cleanup_failed_batch", { target_batch_id: batch_id });
});

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed`);
});
