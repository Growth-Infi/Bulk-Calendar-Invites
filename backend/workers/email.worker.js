import "../config.js";
import { supabase } from "../lib/supabase.js";
import { createCalendarEvent } from "../services/sender.service.js";
import { connection } from "../lib/queue.js";
import { Worker } from "bullmq";
import logger from "../lib/logger.js";

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
      campaign:campaign_id (id, status, start_time, end_time, timezone, event_title, meeting_link, description),
      account:gmail_account_id (id, email, status, refresh_token, access_token, expiry_date),
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

    if (campaign.status == "paused") {
      // console.log(` Campaign paused. Skipping batch ${batch_id}`);
      logger.info(
        { batchId: batch_id, campaignId: campaign.id },
        "Batch skipped — campaign paused",
      );
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
      // console.warn(
      //   `🛑 Account ${account?.email} is ${account?.status}. Marking batch as failed and exiting.`,
      // );

      logger.info(
        { batchId: batch_id, account: account?.email },
        "Batch skipped — Sender Account paused",
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
      // console.log({
      //   start: campaign.start_time,
      //   end: campaign.end_time,
      //   tz: campaign.timezone,
      // });
      const eventId = await createCalendarEvent(account, campaign, emails);

      const { data: success, error: rpcError } = await supabase.rpc(
        "complete_email_batch_v2",
        {
          p_batch_id: batch_id,
          p_google_event_id: eventId,
          p_recipient_ids: recipient_ids,
          p_account_id: account.id,
          p_amount: emails.length,
          p_campaign_id: campaign.id,
        },
      );

      if (rpcError) throw rpcError;
      if (!success) {
        // console.error(`❌ Batch ${batch_id} rejected by DB: Limit exceeded.`);

        logger.error(
          {
            err: rpcError,
            batchId: batch_id,
            email: account.email,
            count: emails.length,
          },
          " RPC call - complete_email_batch, Batch rejected by DB: Limit exceeded.",
        );
        // Note: In this rare case, the email was sent but DB didn't update.
        // The account will likely be paused by the next scheduler loop.
      }

      logger.info(
        { batchId: batch_id, email: account.email, count: emails.length },
        "Batch processed successfully",
      );
    } catch (err) {
      if (isRetryableError(err)) {
        throw err; // BullMQ will retry
      }

      const isAuthError =
        err.response?.status === 401 ||
        err.response?.data?.error?.message === "Invalid Credentials";

      if (isAuthError) {
        await supabase
          .from("recipients")
          .update({ status: "pending", assigned_gmail_account_id: null })
          .in("id", recipient_ids);

        await supabase
          .from("gmail_accounts")
          .update({ status: "needs_reauth" })
          .eq("id", account.id);

        logger.error(
          {
            err: isAuthError,
            batchId: batch_id,
            accountId: account.id,
            email: account.email,
          },
          "Auth error — account marked needs_reauth",
        );

        //  mark the batch failed so it doesn't stay stuck in 'pending'
        await supabase
          .from("event_batches")
          .update({ status: "failed" })
          .eq("id", batch_id);

        return; // don't rethrow — no point retrying auth errors
      }

      // Permanent failure
      const status = err.response?.status || err.code;
      const googleReason = err.response?.data?.error?.errors?.[0]?.reason;
      const customErrorMsg = `${status} - ${googleReason || err.message}`;

      // BETTER ERROR HANDLING
      // const accountFaultReasons = [
      //   "authError",
      //   "accountDeleted",
      //   "domainPolicy",
      //   "insufficientPermissions",
      // ];
      // const shouldBlockAccount = accountFaultReasons.includes(googleReason);

      // await supabase
      //   .from("recipients")
      //   .update({ status: "failed", error: customErrorMsg })
      //   .in("id", recipient_ids);

      // if (shouldBlockAccount) {
      //   await supabase
      //     .from("gmail_accounts")
      //     .update({ status: "blocked" })
      //     .eq("id", account.id);
      // } else {
      //   logger.warn(
      //     { batchId: batch_id, googleReason },
      //     "Batch failed for non-account reason — sender left active",
      //   );
      // }

      await supabase
        .from("recipients")
        .update({ status: "failed", error: customErrorMsg })
        .in("id", recipient_ids);

      await supabase
        .from("gmail_accounts")
        .update({ status: "blocked" })
        .eq("id", account.id);

      // also mark batch failed here, before the outer block does it
      await supabase
        .from("event_batches")
        .update({ status: "failed" })
        .eq("id", batch_id);

      logger.error(
        { err, batchId: batch_id, status, googleReason, msg: err.message },
        "Permanent batch failure",
      );
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

worker.on("failed", async (job, err) => {
  logger.error(
    { jobId: job.id, batchId: job.data.batch_id, err: err },
    "Job permanently failed after all retries",
  );

  const { batch_id } = job.data;

  const { error } = await supabase.rpc("cleanup_failed_batch", {
    target_batch_id: batch_id,
  });

  if (error) {
    // console.error("CRITICAL: cleanup_failed_batch also failed:", error);
    logger.error(
      { err: error },
      " CRITICAL: cleanup_failed_batch also failed:",
    );
  } else {
    logger.info(
      { jobId: job.id, batchId: job.data.batch_id, err: err.message },
      "Cleaned up stuck recipients for batch",
    );

    // console.log(` Cleaned up stuck recipients for batch ${batch_id}`);
  }
});

worker.on("completed", (job) => {
  // console.log(`✅ Job ${job.id} completed`);
  logger.info({ jobId: job.id }, "Job completed");
});
