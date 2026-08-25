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
    expect(source).toContain("const DIRECT_UPLOAD_MAX_ATTEMPTS = 4;");
    expect(source).toContain("const DIRECT_UPLOAD_RETRY_DELAYS_MS = [1_500, 5_000, 12_000];");
    expect(source).toContain("const DIRECT_UPLOAD_STALL_TIMEOUT_MS = 2 * 60_000;");
    expect(source).toContain("const DIRECT_UPLOAD_HARD_TIMEOUT_MS = 25 * 60_000;");
    expect(source).toContain("function directStoragePut");
    expect(source).toContain("Direct storage upload stopped making progress.");
    expect(source).toContain("async function completeDirectUpload");
    expect(source).toContain("for (let attempt = 0; attempt < DIRECT_UPLOAD_MAX_ATTEMPTS; attempt += 1)");
    expect(source).toContain("Secure direct upload could not complete after ${DIRECT_UPLOAD_MAX_ATTEMPTS} attempts");
    expect(source).toContain("return await uploadMediaViaApplication");
  });
});
