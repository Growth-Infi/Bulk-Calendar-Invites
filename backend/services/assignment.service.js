import { supabase } from "../lib/supabase.js";

export const assignRecipients = async (campaign_id, user_id) => {
  const { data: accounts, error: accError } = await supabase
    .from("gmail_accounts")
    .select("*")
    .eq("user_id", user_id)
    .eq("status", "active");

  if (accError) {
    console.error("Accounts fetch error:", accError);
    return;
  }

  if (!accounts || accounts.length === 0) {
    throw new Error("No Gmail accounts found for this user");
  }

  const { data: recipients, error: recError } = await supabase
    .from("recipients")
    .select("*")
    .eq("campaign_id", campaign_id);

  if (recError) {
    console.error("Recipients fetch error:", recError);
    return;
  }

  // console.log("Accounts:", accounts);
  // console.log("Recipients:", recipients);

  const updates = recipients.map((r, i) => ({
    id: r.id,
    email: r.email,
    assigned_gmail_account_id: accounts[i % accounts.length].id,
    campaign_id: campaign_id,
  }));

  const chunkSize = 500;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);

    const { error: upsertError } = await supabase
      .from("recipients")
      .upsert(chunk, { onConflict: "id" });

    if (upsertError) {
      console.error(`Failed at chunk starting at index ${i}:`, upsertError);
      //  'break' here or continue
      throw upsertError;
    }

    console.log(`Processed chunk: ${i + chunk.length} / ${updates.length}`);
  }

  console.log(
    `✅ ${updates.length} recipients assigned with sender emails in one bulk request!`,
  );
};
