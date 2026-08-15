import { processProjectWithGlobalReadablePacing } from "../server/projectProcessor.ts";

const result = await processProjectWithGlobalReadablePacing(1, 240001);
console.log(JSON.stringify(result, null, 2));
