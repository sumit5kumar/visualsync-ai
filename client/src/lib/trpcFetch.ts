const SESSION_PROXY_FAILURE = "SESSION_DNS_FAILED";

export async function fetchTrpcResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await globalThis.fetch(input, {
    ...(init ?? {}),
    credentials: "include",
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok && !contentType.includes("application/json")) {
    const proxyCode = response.headers.get("x-e2b-error-code");
    if (proxyCode === SESSION_PROXY_FAILURE) {
      throw new Error("The application preview connection was interrupted. The request was not processed; please retry now.");
    }
    throw new Error("The API gateway returned an unexpected non-JSON response. The request was not processed; please retry.");
  }

  return response;
}
