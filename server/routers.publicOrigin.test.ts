import { describe, expect, it } from "vitest";
import { requestPublicOrigin } from "./routers";

describe("requestPublicOrigin", () => {
  it("prefers the browser origin over an internal request host", () => {
    expect(requestPublicOrigin({ protocol: "http", headers: { origin: "https://3000-preview.manus.computer" }, get: () => "localhost:3000" })).toBe("https://3000-preview.manus.computer");
  });

  it("uses a forwarded public host when browser origin metadata is absent", () => {
    expect(requestPublicOrigin({ protocol: "http", headers: { "x-forwarded-proto": "https", "x-forwarded-host": "visualsync.example.test" }, get: () => "localhost:3000" })).toBe("https://visualsync.example.test");
  });
});
