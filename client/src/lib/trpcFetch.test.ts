import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTrpcResponse } from "./trpcFetch";

describe("fetchTrpcResponse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns a transient proxy HTML response into an actionable retry error before tRPC tries to parse it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html><html></html>", {
      status: 502,
      headers: { "content-type": "text/html", "x-e2b-error-code": "SESSION_DNS_FAILED" },
    })));

    await expect(fetchTrpcResponse("/api/trpc/gemini.addAndTest", { method: "POST" })).rejects.toThrow("preview connection was interrupted");
  });

  it("retries a transient HTML 504 query response and returns the recovered JSON response", async () => {
    const recovered = new Response(JSON.stringify({ result: { data: { json: true } } }), { status: 200, headers: { "content-type": "application/json" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<html><title>504 Gateway Time-out</title></html>", { status: 504, headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(recovered);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTrpcResponse("/api/trpc/project.list")).resolves.toBe(recovered);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never replays a mutation after a generic gateway HTML response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<!doctype html><html></html>", { status: 504, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTrpcResponse("/api/trpc/project.updateZoom", { method: "POST" })).rejects.toThrow("temporarily unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
