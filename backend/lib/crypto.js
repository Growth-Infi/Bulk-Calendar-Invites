import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();
const ALGO = "aes-256-gcm";
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, "hex"); // 32-byte hex key

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    iv.toString("hex") +
    ":" +
    tag.toString("hex") +
    ":" +
    encrypted.toString("hex")
  );
}

export function decrypt(payload) {
  const [ivHex, tagHex, encHex] = payload.split(":");
  const decipher = crypto.createDecipheriv(
    ALGO,
    KEY,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
