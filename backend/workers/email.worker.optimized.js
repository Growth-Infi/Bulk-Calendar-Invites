const worker = new Worker(
  "email-queue",
  async (job) => {
    const { batch_id } = job.data;

    // 1. Unified Fetch
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

    const emails = batch.recipients.map((r) => r.recipients.email);
    const recipient_ids = batch.recipients.map((r) => r.recipient_id);
    const { account, campaign } = batch;

    // 2. Check Limits
    const { data: limitCheck } = await supabase.rpc(
      "increment_account_sent_safe",
      {
        account_id: account.id,
      },
    );

    if (!limitCheck) {
      console.error(`Daily limit reached: ${account.email}`);
      // Optional: throw error to retry later or move to failed
      return;
    }

    try {
      const eventId = await createCalendarEvent(account, campaign, emails);

      // 3. Combined Status Update (Use a Transaction or Promise.all)
      await Promise.all([
        supabase
          .from("event_batches")
          .update({ google_event_id: eventId, status: "created" })
          .eq("id", batch_id),
        supabase
          .from("recipients")
          .update({ status: "invited" })
          .in("id", recipient_ids),
      ]);
    } catch (error) {
      if (isRetryableError(error)) {
        console.warn(`Retryable error for job ${job.id}: ${error.message}`);
        throw error; // BullMQ takes over
      }

      // 4. Permanent Failure Cleanup
      await Promise.all([
        supabase
          .from("event_batches")
          .update({ status: "failed" })
          .eq("id", batch_id),
        supabase
          .from("recipients")
          .update({
            status: "failed",
            error: error.message,
          })
          .in("id", recipient_ids),
      ]);
    }
  },
  {
    connection,
  },
);
