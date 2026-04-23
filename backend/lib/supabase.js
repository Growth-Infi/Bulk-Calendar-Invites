import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

// Manually trigger config here just in case,
// but we'll ensure the path is correct in the worker
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Supabase environment variables are missing! Check your .env file.",
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);
