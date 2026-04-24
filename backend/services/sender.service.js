import { google } from "googleapis";
import { supabase } from "../lib/supabase.js";

export const createCalendarEvent = async (account, campaign, emails) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );

  oauth2Client.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token,
    expiry_date: account.expiry_date
      ? new Date(account.expiry_date).getTime()
      : null,
  });

  oauth2Client.on("tokens", async (tokens) => {
    await supabase
      .from("gmail_accounts")
      .update({
        access_token: tokens.access_token,
        expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      })
      .eq("id", account.id);
  });

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
  };

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: event,
    sendUpdates: "all",
  });

  return res.data.id;
};
