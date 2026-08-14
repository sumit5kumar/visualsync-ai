/**
 * Gemini Interactions API configuration. The alias resolves to Google's current
 * supported Flash release, avoiding a hard-coded retired model version.
 */
export const GEMINI_MODEL = "gemini-flash-latest";
export const GEMINI_INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

export type GeminiKeyStatus = "verified" | "invalid" | "quota_limited" | "unavailable";
export type GeminiKeyTestResult = { status: GeminiKeyStatus; message: string };
export type GeminiInlinePart = { mimeType: string; dataBase64: string };

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

export type InteractionRequest = {
  model: string;
  input: string | InteractionContent[];
  store: false;
  generation_config: { max_output_tokens: number };
  response_format?: {
    type: "text";
    mime_type: "application/json";
    schema: { type: "object"; additionalProperties: true };
  };
};

class GeminiRequestError extends Error {
  constructor(message: string, readonly status: GeminiKeyStatus) {
    super(message);
  }
}

function classifyGeminiError(statusCode: number, message: string): GeminiRequestError {
  if (statusCode === 401 || statusCode === 403) return new GeminiRequestError("Gemini rejected this API key.", "invalid");
  if (statusCode === 429) return new GeminiRequestError("This Gemini API key has reached a quota or rate limit.", "quota_limited");
  return new GeminiRequestError(message || "Gemini is currently unavailable.", "unavailable");
}

function toInteractionContent(part: GeminiInlinePart): InteractionContent {
  if (part.mimeType.startsWith("audio/")) {
    return { type: "audio", mime_type: part.mimeType, data: part.dataBase64 };
  }
  if (part.mimeType.startsWith("image/")) {
    return { type: "image", mime_type: part.mimeType, data: part.dataBase64 };
  }
  throw new GeminiRequestError(`Unsupported Interactions API media type: ${part.mimeType}`, "unavailable");
}

export function buildInteractionRequest(
  model: string,
  prompt: string,
  inlineParts: GeminiInlinePart[] = [],
  structured = false,
): InteractionRequest {
  const request: InteractionRequest = {
    model,
    input: inlineParts.length > 0 ? [{ type: "text", text: prompt }, ...inlineParts.map(toInteractionContent)] : prompt,
    store: false,
    // The current Flash model can consume a small budget before emitting a text step.
    // 1024 tokens was verified against a live key; 8 tokens returned an incomplete interaction.
    generation_config: { max_output_tokens: structured ? 8192 : 1024 },
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

export class GeminiClient {
  constructor(private readonly apiKey: string, readonly model = GEMINI_MODEL) {}

  private async createInteraction(
    prompt: string,
    inlineParts: GeminiInlinePart[] = [],
    structured = false,
  ): Promise<unknown> {
    const response = await fetch(GEMINI_INTERACTIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(buildInteractionRequest(this.model, prompt, inlineParts, structured)),
      signal: AbortSignal.timeout(45_000),
    });

    if (!response.ok) {
      const errorPayload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw classifyGeminiError(response.status, errorPayload?.error?.message ?? "");
    }

    const payload = (await response.json()) as InteractionResponse & { status?: string };
    const text = extractInteractionText(payload);
    if (!text && payload.status === "incomplete") {
      throw new GeminiRequestError("Gemini did not complete the interaction before its output budget was exhausted. Please retry.", "unavailable");
    }
    if (!text) throw new GeminiRequestError("Gemini returned no usable content for this interaction.", "unavailable");
    if (!structured) return text;

    try {
      return JSON.parse(text);
    } catch {
      throw new GeminiRequestError("Gemini returned malformed structured JSON.", "unavailable");
    }
  }

  async testKey(): Promise<GeminiKeyTestResult> {
    try {
      await this.createInteraction("Respond with exactly OK.");
      return { status: "verified", message: `Gemini API key verified with ${this.model} through the Interactions API.` };
    } catch (error) {
      if (error instanceof GeminiRequestError) return { status: error.status, message: error.message };
      return { status: "unavailable", message: "Gemini could not be reached for this key test." };
    }
  }

  async analyzeAudio(audio: GeminiInlinePart, prompt: string) { return this.createInteraction(prompt, [audio], true); }
  async analyzeImage(image: GeminiInlinePart, prompt: string) { return this.createInteraction(prompt, [image], true); }
  async evaluateImageCandidates(prompt: string) { return this.createInteraction(prompt, [], true); }
  async reasonAboutTimeline(prompt: string) { return this.createInteraction(prompt, [], true); }
  async reviewTimeline(prompt: string) { return this.createInteraction(prompt, [], true); }
}
