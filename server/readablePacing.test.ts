import { describe, expect, it } from "vitest";
import { buildGlobalReadableImageDurations, distributeReadableWeightedDurations, MIN_READABLE_IMAGE_DURATION_MS, resolveReadableMinimumDuration } from "./readablePacing";

describe("distributeReadableWeightedDurations", () => {
  it("preserves the full narration duration while enforcing a readable minimum and variable Groq-weighted pacing", () => {
    const durations = distributeReadableWeightedDurations(67_451, [0.8, 1.1, 1.4, 0.9, 1.7, 1.2, 1.5, 1.0, 1.3, 0.7, 1.6, 1.25, 0.95, 1.45, 1.05, 1.8, 1.15, 1.55, 0.85, 1.35]);

    expect(durations).toHaveLength(20);
    expect(durations.every(duration => duration >= MIN_READABLE_IMAGE_DURATION_MS)).toBe(true);
    expect(durations.reduce((sum, duration) => sum + duration, 0)).toBe(67_451);
    expect(new Set(durations).size).toBeGreaterThan(1);
  });

  it("rejects a readable-duration request that cannot fit inside the narration", () => {
    expect(() => distributeReadableWeightedDurations(4_000, [1, 1])).toThrow("cannot fit");
  });

  it("keeps the Finance-quality preferred minimum when narration length supports it", () => {
    expect(resolveReadableMinimumDuration(67_451, 20)).toBe(MIN_READABLE_IMAGE_DURATION_MS);
  });

  it("adapts the readable minimum for a shorter real narration without using equal splits", () => {
    const plan = buildGlobalReadableImageDurations(12_000, [0.8, 1.1, 1.3, 0.9, 1.4, 1.0]);

    expect(plan.minimumDurationMs).toBe(1_600);
    expect(plan.durations.reduce((sum, duration) => sum + duration, 0)).toBe(12_000);
    expect(new Set(plan.durations).size).toBeGreaterThan(1);
  });

  it("supports no artificial minimum hold while preserving positive complete coverage", () => {
    const plan = buildGlobalReadableImageDurations(12_000, [0.8, 1.1, 1.3, 0.9, 1.4, 1.0], "NO_MINIMUM");

    expect(plan.minimumDurationMs).toBe(0);
    expect(plan.durations.every(duration => duration > 0)).toBe(true);
    expect(plan.durations.reduce((sum, duration) => sum + duration, 0)).toBe(12_000);
    expect(plan.durations.some(duration => duration < MIN_READABLE_IMAGE_DURATION_MS)).toBe(true);
  });

  it("keeps the current two-second mode as the default", () => {
    expect(buildGlobalReadableImageDurations(67_451, [1, 2, 3]).minimumDurationMs).toBe(MIN_READABLE_IMAGE_DURATION_MS);
  });
});
