import { describe, expect, it } from "vitest";
import { describeGeminiKey } from "./crypto";
describe("describeGeminiKey", () => { it("returns a masked representation without retaining the middle of a key", () => { const description = describeGeminiKey("AIzaSyDemoKeyOnlyForUnitTest9876"); expect(description.masked).toBe("AIza••••••••9876"); expect(description.masked).not.toContain("DemoKeyOnlyForUnitTest"); }); });
