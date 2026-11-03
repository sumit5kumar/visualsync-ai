import type { GroqFailureCategory, GroqRequestMetadata } from "./groqClient";

/**
 * Gemini Interactions API configuration. The alias resolves to Google's current
 * supported Flash release, avoiding a hard-coded retired model version.
 */
export const GEMINI_MODEL = "gemini-flash-lite-latest";
/**
 * Heavier Flash alias used only after the primary model keeps answering
 * 503/overloaded. A 503 "high demand" is model-wide capacity pressure (not a
 * key problem), so switching keys does not help but switching model usually does.
 * flash-lite is the primary model because it has the higher request rate limits;
 * the fuller flash model is kept purely as a capacity fallback on overload.
 */
export const GEMINI_FALLBACK_MODEL = "gemini-flash-latest";
export const GEMINI_INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

export type GeminiKeyStatus = "verified" | "invalid" | "quota_limited" | "unavailable";
export type GeminiKeyTestResult = { status: GeminiKeyStatus; message: string; model?: string };
export type GeminiInlinePart = { mimeType: string; dataBase64: string };
/** Same shape as Groq metadata so hosted-job retry/backoff logic treats both providers identically. */
export type GeminiRequestMetadata = GroqRequestMetadata & { model?: string };

export type GeminiRetryPolicy = {
  /** Attempts per model for transient (5xx / overloaded / network / timeout) failures. */
  maxAttemptsPerModel: number;
  /** Model tried after the primary model exhausts its transient retries. null disables fallback. */
  fallbackModel: string | null;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Wall-clock budget for all attempts, so a hosted job slice cannot overrun its lease. */
  totalBudgetMs: number;
  requestTimeoutMs: number;
};

export const DEFAULT_GEMINI_RETRY_POLICY: GeminiRetryPolicy = {
  maxAttemptsPerModel: 3,
  fallbackModel: GEMINI_FALLBACK_MODEL,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  totalBudgetMs: 75_000,
  requestTimeoutMs: 45_000,
};

type InteractionContent =
  | { type: "text"; text: string }
  | { type: "audio"; mime_type: string; data: string }
  | { type: "image"; mime_type: string; data: string };

type InteractionResponse = {
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

type GeminiErrorPayload = { error?: { message?: string; status?: string; details?: Array<{ "@type"?: string; retryDelay?: string; reason?: string }> } } | null;

export type InteractionRequest = {
  model: string;
  input: string | InteractionContent[];
  store: false;
  generation_config: {
    max_output_tokens: number;
    /** Reasoning intensity: "low" minimizes internal thinking. Analysis and pacing
     *  tasks here are extraction/classification, not deep reasoning, so thinking is
     *  kept at its lowest documented level to save output budget and latency. */
    thinking_level?: "low";
    /** Disables separate thought summaries; only model_output text is consumed. */
    thinking_summaries?: "none";
  };
  response_format?: {
    type: "text";
    mime_type: "application/json";
    schema: { type: "object"; additionalProperties: true };
  };
};

export class GeminiRequestError extends Error {
  constructor(message: string, readonly status: GeminiKeyStatus, readonly metadata: GeminiRequestMetadata = { durationMs: 0, category: "unknown" }) {
    super(safeGeminiMessage(message));
  }
}

function safeGeminiMessage(message: string) {
  return message.replace(/AIza[A-Za-z0-9_-]+/g, "[redacted key]").replace(/https?:\/\/\S+/gi, "[secure URL]").trim();
}

/** Parses Retry-After (seconds or HTTP date) or Google RetryInfo durations like "17s" / "1.5s". */
export function parseGeminiRetryDelayMs(value: string | null | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  const duration = trimmed.match(/^([\d.]+)\s*s$/i);
  if (duration) {
    const seconds = Number(duration[1]);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

export function classifyGeminiError(statusCode: number, payload: GeminiErrorPayload, retryAfterHeader: string | null, durationMs: number, model: string): GeminiRequestError {
  const message = payload?.error?.message ?? "";
  const providerStatus = payload?.error?.status ?? "";
  const retryInfo = payload?.error?.details?.find(detail => detail["@type"]?.includes("RetryInfo"))?.retryDelay;
  const retryAfterMs = parseGeminiRetryDelayMs(retryAfterHeader) ?? parseGeminiRetryDelayMs(retryInfo);
  const metadata = (category: GroqFailureCategory): GeminiRequestMetadata => ({ httpStatus: statusCode, errorCode: providerStatus || undefined, retryAfterMs, durationMs, category, model });
  const keyRejected = statusCode === 401 || statusCode === 403 || /API[_ ]KEY[_ ]INVALID|API key not valid|API key expired/i.test(`${message} ${payload?.error?.details?.map(detail => detail.reason ?? "").join(" ") ?? ""}`);
  if (keyRejected) return new GeminiRequestError("Gemini rejected this API key.", "invalid", metadata(statusCode === 403 ? "permission_denied" : "invalid_key"));
  if (statusCode === 429) return new GeminiRequestError("This Gemini API key has reached a quota or rate limit.", "quota_limited", metadata("rate_limited"));
  if (statusCode === 408 || statusCode === 504) return new GeminiRequestError("Gemini timed out while processing this request.", "unavailable", metadata("timeout"));
  if (statusCode >= 500) {
    const overloaded = statusCode === 503 || /overload|high demand|UNAVAILABLE/i.test(`${message} ${providerStatus}`);
    return new GeminiRequestError(overloaded ? "Gemini is experiencing high demand (503). The request was retried and will be retried again automatically." : (message || "Gemini returned a server error."), "unavailable", metadata("server_error"));
  }
  return new GeminiRequestError(message || "Gemini rejected this request.", "unavailable", metadata("client_request"));
}

/** Transient failures are model-wide capacity/network problems: retry with backoff, never penalize the key. */
export function isTransientGeminiFailure(error: unknown) {
  if (!(error instanceof GeminiRequestError) || error.status !== "unavailable") return false;
  // An "incomplete" (output budget) answer is deterministic for the same budget,
  // so it is surfaced to the caller instead of being blindly retried.
  return error.metadata.category === "server_error" || error.metadata.category === "timeout" || error.metadata.category === "network_failure";
}

/** Exponential backoff with full jitter in [delay/2, delay], honoring a provider-supplied delay when present. */
export function geminiBackoffDelayMs(attempt: number, policy: GeminiRetryPolicy, retryAfterMs?: number, random = Math.random) {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.min(policy.maxDelayMs, Math.round(retryAfterMs));
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

function toInteractionContent(part: GeminiInlinePart): InteractionContent {
  if (part.mimeType.startsWith("audio/")) {
    return { type: "audio", mime_type: part.mimeType, data: part.dataBase64 };
  }
  if (part.mimeType.startsWith("image/")) {
    return { type: "image", mime_type: part.mimeType, data: part.dataBase64 };
  }
  throw new GeminiRequestError(`Unsupported Interactions API media type: ${part.mimeType}`, "unavailable", { durationMs: 0, category: "client_request" });
}

export function buildInteractionRequest(
  model: string,
  prompt: string,
  inlineParts: GeminiInlinePart[] = [],
  structured = false,
  maxOutputTokens?: number,
): InteractionRequest {
  const request: InteractionRequest = {
    model,
    input: inlineParts.length > 0 ? [{ type: "text", text: prompt }, ...inlineParts.map(toInteractionContent)] : prompt,
    store: false,
    // The current Flash model can consume a small budget before emitting a text step.
    // 1024 tokens was verified against a live key; 8 tokens returned an incomplete interaction.
    // Analysis and pacing here are extraction/classification tasks, so internal
    // thinking is kept at its lowest documented level and summaries are disabled.
    generation_config: { max_output_tokens: maxOutputTokens ?? (structured ? 8192 : 1024), thinking_level: "low", thinking_summaries: "none" },
  };

  if (structured) {
    request.response_format = {
      type: "text",
      mime_type: "application/json",
      schema: { type: "object", additionalProperties: true },
    };
  }
  return request;
}

export function extractInteractionText(payload: InteractionResponse): string {
  return payload.steps
    ?.filter(step => step.type === "model_output")
    .flatMap(step => step.content ?? [])
    .filter(content => content.type === "text")
    .map(content => content.text ?? "")
    .join("")
    .trim() ?? "";
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export type GeminiClientOptions = {
  retryPolicy?: Partial<GeminiRetryPolicy>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type GeminiInteractionOptions = { structured?: boolean; maxOutputTokens?: number };

export class GeminiClient {
  private readonly policy: GeminiRetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  /** Model that produced the most recent successful answer (primary or fallback). */
  lastModelUsed: string | null = null;

  constructor(private readonly apiKey: string, readonly model = GEMINI_MODEL, options: GeminiClientOptions = {}) {
    this.policy = { ...DEFAULT_GEMINI_RETRY_POLICY, ...options.retryPolicy };
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  private async sendOnce(model: string, prompt: string, inlineParts: GeminiInlinePart[], options: GeminiInteractionOptions): Promise<unknown> {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(GEMINI_INTERACTIONS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(buildInteractionRequest(model, prompt, inlineParts, options.structured ?? false, options.maxOutputTokens)),
        signal: AbortSignal.timeout(this.policy.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new GeminiRequestError(timedOut ? "Gemini timed out while processing this request." : "Gemini could not be reached for this request.", "unavailable", { durationMs: Date.now() - startedAt, category: timedOut ? "timeout" : "network_failure", model });
    }
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const errorPayload = (await response.json().catch(() => null)) as GeminiErrorPayload;
      throw classifyGeminiError(response.status, errorPayload, response.headers.get("retry-after"), durationMs, model);
    }

    const payload = (await response.json()) as InteractionResponse & { status?: string };
    const text = extractInteractionText(payload);
    if (!text && payload.status === "incomplete") {
      throw new GeminiRequestError("Gemini did not complete the interaction before its output budget was exhausted. Please retry.", "unavailable", { httpStatus: response.status, durationMs, category: "unknown", model });
    }
    if (!text) throw new GeminiRequestError("Gemini returned no usable content for this interaction.", "unavailable", { httpStatus: response.status, durationMs, category: "unknown", model });
    if (!options.structured) return text;

    try {
      return JSON.parse(text);
    } catch {
      throw new GeminiRequestError("Gemini returned malformed structured JSON.", "unavailable", { httpStatus: response.status, durationMs, category: "client_request", model });
    }
  }

  /**
   * Runs one interaction with the 503 stability policy:
   * transient failures retry on the primary model with jittered backoff, then on
   * the fallback model. Key-specific failures (invalid key, 429 quota) are thrown
   * immediately so the key pool can rotate/cool down that key.
   */
  async createInteraction(prompt: string, inlineParts: GeminiInlinePart[] = [], options: GeminiInteractionOptions = {}): Promise<unknown> {
    const deadline = Date.now() + this.policy.totalBudgetMs;
    const models = [this.model, ...(this.policy.fallbackModel && this.policy.fallbackModel !== this.model ? [this.policy.fallbackModel] : [])];
    let lastTransient: GeminiRequestError | undefined;
    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const model = models[modelIndex];
      for (let attempt = 1; attempt <= this.policy.maxAttemptsPerModel; attempt += 1) {
        try {
          const result = await this.sendOnce(model, prompt, inlineParts, options);
          this.lastModelUsed = model;
          return result;
        } catch (error) {
          if (!isTransientGeminiFailure(error)) {
            // A missing fallback alias must not hide the real primary-model 503.
            if (modelIndex > 0 && lastTransient && error instanceof GeminiRequestError && error.metadata.category === "client_request" && error.metadata.httpStatus === 404) throw lastTransient;
            throw error;
          }
          lastTransient = error as GeminiRequestError;
          const isLastAttemptForModel = attempt >= this.policy.maxAttemptsPerModel;
          if (isLastAttemptForModel) break;
          const delay = geminiBackoffDelayMs(attempt, this.policy, lastTransient.metadata.retryAfterMs, this.random);
          if (Date.now() + delay >= deadline) break;
          await this.sleep(delay);
        }
      }
      if (Date.now() >= deadline) break;
    }
    throw lastTransient ?? new GeminiRequestError("Gemini is currently unavailable.", "unavailable", { durationMs: 0, category: "server_error" });
  }

  async testKey(): Promise<GeminiKeyTestResult> {
    try {
      // Retry transient 503s with backoff and the lite fallback model. A single
      // high-demand blip must not make a valid key look "busy" on the Test
      // button; only an exhausted retry budget surfaces as unavailable.
      await this.createInteraction("Respond with exactly OK.");
      return { status: "verified", message: `Gemini API key verified with ${this.lastModelUsed ?? this.model} through the Interactions API.` };
    } catch (error) {
      if (error instanceof GeminiRequestError) {
        if (isTransientGeminiFailure(error)) return { status: "unavailable", message: "Gemini servers are busy right now (high demand). This key was NOT rejected — the pool will rotate to another key automatically." };
        return { status: error.status, message: error.message };
      }
      return { status: "unavailable", message: "Gemini could not be reached for this key test." };
    }
  }

  async generateJson(prompt: string, inlineParts: GeminiInlinePart[] = [], maxOutputTokens?: number) { return this.createInteraction(prompt, inlineParts, { structured: true, maxOutputTokens }); }
  async analyzeAudio(audio: GeminiInlinePart, prompt: string) { return this.createInteraction(prompt, [audio], { structured: true }); }
  async analyzeImage(image: GeminiInlinePart, prompt: string) { return this.createInteraction(prompt, [image], { structured: true }); }
  async analyzeImageBatch(images: GeminiInlinePart[], prompt: string, maxOutputTokens?: number) { return this.createInteraction(prompt, images, { structured: true, maxOutputTokens }); }
  async evaluateImageCandidates(prompt: string) { return this.createInteraction(prompt, [], { structured: true }); }
  async reasonAboutTimeline(prompt: string) { return this.createInteraction(prompt, [], { structured: true }); }
  async reviewTimeline(prompt: string) { return this.createInteraction(prompt, [], { structured: true }); }
}
