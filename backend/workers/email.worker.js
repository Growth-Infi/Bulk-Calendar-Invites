import "../config.js";
import { supabase } from "../lib/supabase.js";
import { createCalendarEvent } from "../services/sender.service.js";
import { connection } from "../lib/queue.js";
import { tryCatch, Worker } from "bullmq";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isRetryableError = (error) => {
  const status = error.response?.status || error.code;
  const reason = error.response?.data?.error?.errors?.[0]?.reason;

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

    const { data: batch } = await supabase
      .from("event_batches")
      .select("*")
      .eq("id", batch_id)
      .single();

    const { data: campaign } = await supabase
      .from("campaigns")
      .select("*")
      .eq("id", batch.campaign_id)
      .single();

    const { data: account } = await supabase
      .from("gmail_accounts")
      .select("*")
      .eq("id", batch.gmail_account_id)
      .single();

    const { data: mappings } = await supabase
      .from("batch_recipients")
      .select("recipient_id")
      .eq("batch_id", batch_id);

    const recipient_ids = mappings.map((m) => m.recipient_id);

    const { data: recipients } = await supabase
      .from("recipients")
      .select("email")
      .in("id", recipient_ids);

    const emails = recipients.map((r) => r.email);

    const success = await supabase.rpc("increment_account_sent_safe", {
      account_id: account.id,
    });

    if (!success) {
      console.error("Daily limit reached for email - ", account.email);
    }
    try {
      const eventId = await createCalendarEvent(account, campaign, emails);

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
    } catch (err) {
      if (isRetryableError(err)) {
        throw err; // retry via BullMQ
      }

      // permanent failure
      await supabase
        .from("event_batches")
        .update({
          status: "failed",
        })
        .eq("id", batch_id);

      await supabase
        .from("recipients")
        .update({
          status: "failed",
          error: err.message,
        })
        .in("id", recipient_ids);

      return;
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
  console.error(`❌ Job ${job.id} failed:`, err.message);
});

worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed`);
});
