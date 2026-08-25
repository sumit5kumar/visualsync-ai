import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("project storage warning surface", () => {
  it("keeps storage accounting user-scoped and exposes only a manual-deletion warning", () => {
    const database = readFileSync(resolve(process.cwd(), "server/db.ts"), "utf8");
    const router = readFileSync(resolve(process.cwd(), "server/routers.ts"), "utf8");
    const projects = readFileSync(resolve(process.cwd(), "client/src/pages/Projects.tsx"), "utf8");

    expect(database).toContain("getUserMediaStorageUsage(userId: number)");
    expect(database).toContain("where(eq(mediaAssets.userId, userId))");
    expect(router).toContain("storageUsage: protectedProcedure.query");
    expect(projects).toContain("Nothing is deleted automatically.");
    expect(projects).toContain("VisualSync-recorded media estimate");
    expect(projects).toContain("utils.project.storageUsage.invalidate()");
  });
});
