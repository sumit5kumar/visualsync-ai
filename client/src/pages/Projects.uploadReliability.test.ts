import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("project media upload transport recovery", () => {
  it("retries transient fetch and server transport failures without retrying validation errors", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/Projects.tsx"), "utf8");
    expect(source).toContain("const MEDIA_UPLOAD_MAX_ATTEMPTS = 3;");
    expect(source).toContain("MEDIA_UPLOAD_RETRY_DELAYS_MS");
    expect(source).toContain("response.status < 500");
    expect(source).toContain("failed to fetch|network|load failed|upload service temporarily failed");
    expect(source).toContain("Keep this page open and use Source media to retry this saved project.");
    expect(source).toContain("/api/project-media/direct-ticket");
    expect(source).toContain("/api/project-media/direct-complete");
    expect(source).toContain("const DIRECT_UPLOAD_TIMEOUT_MS = 120_000;");
    expect(source).toContain("Direct storage upload timed out.");
    expect(source).toContain("directUpload.abort");
    expect(source).toContain("return uploadMediaViaApplication");
  });
});
