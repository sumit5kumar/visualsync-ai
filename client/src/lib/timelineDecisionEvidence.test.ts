import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { timelineDecisionEvidence } from "./timelineDecisionEvidence";

describe("timeline decision evidence", () => {
  it("shows the actual Groq pacing weight instead of inventing a match percentage", () => {
    expect(timelineDecisionEvidence("Groq retained user-supplied image 3 in chronological script order and assigned a variable full-narration pacing weight of 1.37.")).toBe("Groq pacing ×1.37");
  });

  it("falls back to an accurate provider-decision label when no pacing weight is stored", () => {
    expect(timelineDecisionEvidence("Groq retained the image in chronological script order.")).toBe("Groq ordered source");
  });

  it("wires decision evidence into Timeline cards without the obsolete percentage formatter", () => {
    const timelineSource = readFileSync(resolve(process.cwd(), "client/src/pages/Timeline.tsx"), "utf8");
    expect(timelineSource).toContain("timelineDecisionEvidence(segment.selectionReason)");
    expect(timelineSource).not.toContain("Math.round(Number(segment.confidence) * 100)");
  });
});
