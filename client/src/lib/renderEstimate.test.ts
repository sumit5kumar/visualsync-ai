import { describe, expect, it } from "vitest";
import { estimateNativeRender, formatRenderDuration } from "./renderEstimate";

describe("native render estimate", () => {
  it("returns a bounded 30 fps estimate from real timeline inputs", () => {
    const estimate = estimateNativeRender({ durationMs: 67_451, imageCount: 20, zoomEnabled: true, crossfadeDurationMs: 800 });
    expect(estimate).toMatchObject({ outputFrames: 2024 });
    expect(estimate?.lowerSeconds).toBeLessThan(estimate?.expectedSeconds ?? 0);
    expect(estimate?.upperSeconds).toBeGreaterThan(estimate?.expectedSeconds ?? 0);
  });

  it("shows the materially higher cost of smooth zoom and rejects incomplete inputs", () => {
    const zoomed = estimateNativeRender({ durationMs: 60_000, imageCount: 12, zoomEnabled: true, crossfadeDurationMs: 800 });
    const staticFrames = estimateNativeRender({ durationMs: 60_000, imageCount: 12, zoomEnabled: false, crossfadeDurationMs: 800 });
    expect(zoomed?.expectedSeconds).toBeGreaterThan(staticFrames?.expectedSeconds ?? 0);
    expect(estimateNativeRender({ durationMs: 0, imageCount: 12, zoomEnabled: true, crossfadeDurationMs: 800 })).toBeNull();
    expect(formatRenderDuration(3_661)).toBe("1h 1m");
  });
});
