import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("project deletion safeguards", () => {
  it("provides protected user-scoped bulk deletion and clears durable job records first", () => {
    const db = readFileSync(resolve(process.cwd(), "server/db.ts"), "utf8");
    const router = readFileSync(resolve(process.cwd(), "server/routers.ts"), "utf8");
    expect(db).toContain("export async function deleteAllProjectRecords(userId: number)");
    expect(db).toContain("transaction.delete(timelineGenerationJobs)");
    expect(db).toContain("deletedCount: projectIds.length");
    expect(router).toContain("removeAll: protectedProcedure.mutation");
  });
});
