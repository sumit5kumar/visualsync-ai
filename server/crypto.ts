import { createHash, createDecipheriv, createCipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
export type EncryptedSecret = { ciphertext: string; iv: string; tag: string };

function encryptionKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Server encryption is unavailable because the session secret is not configured.");
  return scryptSync(secret, "visualsync-ai:key-vault:v1", 32);
}

export function encryptSecret(value: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export const fingerprintSecret = (value: string) => createHash("sha256").update(value).digest("hex");
export function describeApiKey(value: string) {
  const normalized = value.trim();
  return { prefix: normalized.slice(0, 4) || "key", suffix: normalized.slice(-4) || "••••", masked: `${normalized.slice(0, 4) || "key"}••••••••${normalized.slice(-4) || "••••"}` };
}

export const describeGeminiKey = describeApiKey;
