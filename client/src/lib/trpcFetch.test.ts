import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTrpcResponse } from "./trpcFetch";

describe("fetchTrpcResponse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns a transient proxy HTML response into an actionable retry error before tRPC tries to parse it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html><html></html>", {
      status: 502,
      headers: { "content-type": "text/html", "x-e2b-error-code": "SESSION_DNS_FAILED" },
    })));

    await expect(fetchTrpcResponse("/api/trpc/gemini.addAndTest")).rejects.toThrow("preview connection was interrupted");
  });

  it("preserves valid JSON error responses for tRPC's normal error parser", async () => {
    const response = new Response(JSON.stringify({ error: { message: "Invalid key" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(fetchTrpcResponse("/api/trpc/gemini.addAndTest")).resolves.toBe(response);
  });
});
