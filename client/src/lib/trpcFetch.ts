const SESSION_PROXY_FAILURE = "SESSION_DNS_FAILED";
const RETRYABLE_GATEWAY_STATUSES = new Set([502, 503, 504]);
const QUERY_TIMEOUT_MS = 20_000;
const GATEWAY_RETRY_DELAY_MS = 300;
const MAX_QUERY_GATEWAY_ATTEMPTS = 3;

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function wait(delayMs: number) {
  return new Promise<void>(resolve => globalThis.setTimeout(resolve, delayMs));
}

function withDeadline(signal: AbortSignal | null | undefined, timeoutController: AbortController) {
  if (!signal) return timeoutController.signal;
  return AbortSignal.any([signal, timeoutController.signal]);
}

/**
 * Keeps tRPC query batches responsive when a transient gateway route returns its
 * HTML 502/503/504 page. The request is bounded locally and retried only for GET
 * queries, so mutations are never replayed automatically.
 */
export async function fetchTrpcResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = requestMethod(input, init);
  const canRetryGatewayFailure = method === "GET";
  let lastGatewayResponse: Response | null = null;
  let timedOut = false;

  for (let attempt = 0; attempt < (canRetryGatewayFailure ? MAX_QUERY_GATEWAY_ATTEMPTS : 1); attempt++) {
    const timeoutController = new AbortController();
    const timeout = globalThis.setTimeout(() => timeoutController.abort(), QUERY_TIMEOUT_MS);
    try {
      const response = await globalThis.fetch(input, {
        ...(init ?? {}),
        credentials: "include",
        signal: withDeadline(init?.signal, timeoutController),
      });
      const contentType = response.headers.get("content-type") ?? "";
      const isGatewayHtml = !response.ok && !contentType.includes("application/json");
      const isRetryableGatewayFailure = isGatewayHtml && RETRYABLE_GATEWAY_STATUSES.has(response.status);
      if (!isRetryableGatewayFailure || !canRetryGatewayFailure || attempt === MAX_QUERY_GATEWAY_ATTEMPTS - 1) {
        if (isGatewayHtml) {
          const proxyCode = response.headers.get("x-e2b-error-code");
          if (proxyCode === SESSION_PROXY_FAILURE) throw new Error("The application preview connection was interrupted. The request was not processed; please retry now.");
          if (isRetryableGatewayFailure) throw new Error("The API gateway was temporarily unavailable. The Preview request was retried automatically; please refresh if it is still unavailable.");
          throw new Error("The API gateway returned an unexpected non-JSON response. The request was not processed; please retry.");
        }
        return response;
      }
      lastGatewayResponse = response;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "AbortError" || !timeoutController.signal.aborted || !canRetryGatewayFailure || attempt === MAX_QUERY_GATEWAY_ATTEMPTS - 1) throw error;
      timedOut = true;
    } finally {
      globalThis.clearTimeout(timeout);
    }
    await wait(GATEWAY_RETRY_DELAY_MS * (attempt + 1));
  }

  if (timedOut) throw new Error("The Preview request timed out before the gateway responded. It was retried automatically; please refresh if it is still unavailable.");
  if (lastGatewayResponse) throw new Error("The API gateway was temporarily unavailable. The Preview request was retried automatically; please refresh if it is still unavailable.");
  throw new Error("The Preview request could not reach the API gateway. Please retry.");
}
