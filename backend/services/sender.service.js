import { google } from "googleapis";
import { supabase } from "../lib/supabase.js";
import { encrypt, decrypt } from "../lib/crypto.js";

export const createCalendarEvent = async (account, campaign, emails) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );

  oauth2Client.setCredentials({
    refresh_token: decrypt(account.refresh_token),
    access_token: decrypt(account.access_token),
    expiry_date: account.expiry_date
      ? new Date(account.expiry_date).getTime()
      : null,
  });

  // This ensures that if getAccessToken() refreshes the token, we catch it.
  oauth2Client.on("tokens", async (tokens) => {
    const updateData = {
      access_token: encrypt(tokens.access_token),
      expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    };

    // Google only sends a refresh_token on the first auth.
    // But if it IS present in the refresh response, save it
    if (tokens.refresh_token) {
      updateData.refresh_token = encrypt(tokens.refresh_token);
    }

    await supabase
      .from("gmail_accounts")
      .update(updateData)
      .eq("id", account.id);
  });

  try {
    // 3. Trigger the refresh if needed
    await oauth2Client.getAccessToken();

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const event = {
      summary: campaign.event_title,
      location: campaign.meeting_link,
      description: campaign.description,
      start: {
        dateTime: campaign.start_time,
        timeZone: campaign.timezone,
      },
      end: {
        dateTime: campaign.end_time,
        timeZone: campaign.timezone,
      },
      attendees: emails.map((e) => ({ email: e })),
      guestsCanSeeOtherGuests: false,

      // reminders: {
      //   useDefault: false,
      //   overrides: [
      //     { method: "email", minutes: 30 }, // email reminder 30 min before
      //     { method: "popup", minutes: 10 }, // popup reminder 10 min before
      //   ],
      // },
    };

    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event,
      sendUpdates: "all",
    });

    return res.data.id;
  } catch (error) {
    console.error("Error creating calendar event:", error);
    throw error;
  }
};
