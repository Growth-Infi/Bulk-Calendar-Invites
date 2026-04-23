import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();
console.log("CLIENT_ID:", process.env.GOOGLE_CLIENT_ID);

export const createOAuthClient = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
};
