import "dotenv/config";
import { processProjectWithGlobalReadablePacing } from "../server/projectProcessor.ts";

const userId = 1;
const projectId = 120003;

const result = await processProjectWithGlobalReadablePacing(userId, projectId);
console.log(JSON.stringify({ projectId, imageCount: result.imageCount, minimumDurationMs: result.minimumDurationMs, valid: result.validation.valid, issues: result.validation.issues }, null, 2));
