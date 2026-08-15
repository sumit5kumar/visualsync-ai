import { executeWithGroqRotation } from "../server/groqPool.ts";

const result = await executeWithGroqRotation(1, async (client, key) => ({ key, value: await client.completeText({ prompt: "Choose one image. Respond only as ID=<integer>;CONFIDENCE=<decimal from 0 to 1>. Do not add explanation. Available images: [{\"imageAssetId\":2,\"scene\":\"office desk\"},{\"imageAssetId\":3,\"scene\":\"bank building\"}]." }) }));
console.log(JSON.stringify(result));
