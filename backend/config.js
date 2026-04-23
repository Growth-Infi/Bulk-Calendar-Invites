import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This works regardless of which folder you run the command from
dotenv.config({ path: path.resolve(__dirname, ".env") });

console.log("✅ Environment Variables Loaded");
