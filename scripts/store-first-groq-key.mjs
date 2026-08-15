import { decryptSecret, describeApiKey, encryptSecret, fingerprintSecret } from "../server/crypto.ts";
import { saveValidatedGroqKey } from "../server/db.ts";
import { GroqClient } from "../server/groqClient.ts";

const userId = 1;
const label = "First Groq Key";
const apiKey = process.env.GROQ_API_KEY?.trim();

if (!apiKey) throw new Error("GROQ_API_KEY is not available to this server-side initializer.");
const verification = await new GroqClient(apiKey).testKey();
if (verification.status !== "verified") throw new Error(verification.message);

const encrypted = encryptSecret(apiKey);
const descriptor = describeApiKey(apiKey);
try {
  await saveValidatedGroqKey(userId, {
    label,
    keyPrefix: descriptor.prefix,
    keySuffix: descriptor.suffix,
    keyFingerprint: fingerprintSecret(apiKey),
    encryptedCiphertext: encrypted.ciphertext,
    encryptionIv: encrypted.iv,
    encryptionTag: encrypted.tag,
  });
  const restored = decryptSecret(encrypted);
  if (restored !== apiKey) throw new Error("Encrypted Groq key failed the in-memory round-trip check.");
  console.log(`Stored verified encrypted Groq key: ${label}`);
} catch (error) {
  if (error instanceof Error && error.message.includes("already saved")) console.log("Verified Groq key is already stored; no duplicate was created.");
  else throw error;
} finally {
  process.exit(0);
}
