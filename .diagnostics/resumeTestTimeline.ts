import { processProjectWithGlobalReadablePacing } from "../server/projectProcessor";

async function main() {
  const result = await processProjectWithGlobalReadablePacing(1, 360001);
  console.log(JSON.stringify({ projectId: 360001, imageCount: result.imageCount, minimumDurationMs: result.minimumDurationMs, status: "timeline_ready" }));
}

void main();
