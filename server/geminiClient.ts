export const GEMINI_MODEL = "gemini-2.5-flash";
export type GeminiKeyStatus = "verified" | "invalid" | "quota_limited" | "unavailable";
export type GeminiKeyTestResult = { status: GeminiKeyStatus; message: string };
export type GeminiInlinePart = { mimeType: string; dataBase64: string };

class GeminiRequestError extends Error { constructor(message: string, readonly status: GeminiKeyStatus) { super(message); } }
function classifyGeminiError(statusCode: number, message: string): GeminiRequestError {
  if (statusCode === 401 || statusCode === 403) return new GeminiRequestError("Gemini rejected this API key.", "invalid");
  if (statusCode === 429) return new GeminiRequestError("This Gemini API key has reached a quota or rate limit.", "quota_limited");
  return new GeminiRequestError(message || "Gemini is currently unavailable.", "unavailable");
}
function extractText(payload: unknown): string { const candidate = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0]; return candidate?.content?.parts?.map(part => part.text ?? "").join("").trim() ?? ""; }

export class GeminiClient {
  constructor(private readonly apiKey: string, readonly model = GEMINI_MODEL) {}
  private async generateContent(prompt: string, inlineParts: GeminiInlinePart[] = [], structured = false): Promise<unknown> {
    const parts = [{ text: prompt }, ...inlineParts.map(part => ({ inlineData: { mimeType: part.mimeType, data: part.dataBase64 } }))];
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: structured ? { responseMimeType: "application/json", temperature: 0.1 } : { temperature: 0, maxOutputTokens: 8 } }), signal: AbortSignal.timeout(45_000) });
    if (!response.ok) { const errorPayload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null; throw classifyGeminiError(response.status, errorPayload?.error?.message ?? ""); }
    const text = extractText(await response.json());
    if (!text) throw new GeminiRequestError("Gemini returned no usable content for this request.", "unavailable");
    return structured ? JSON.parse(text) : text;
  }
  async testKey(): Promise<GeminiKeyTestResult> { try { await this.generateContent("Respond with exactly OK."); return { status: "verified", message: "Gemini API key verified with gemini-2.5-flash." }; } catch (error) { if (error instanceof GeminiRequestError) return { status: error.status, message: error.message }; return { status: "unavailable", message: "Gemini could not be reached for this key test." }; } }
  async analyzeAudio(audio: GeminiInlinePart, prompt: string) { return this.generateContent(prompt, [audio], true); }
  async analyzeImage(image: GeminiInlinePart, prompt: string) { return this.generateContent(prompt, [image], true); }
  async evaluateImageCandidates(prompt: string) { return this.generateContent(prompt, [], true); }
  async reasonAboutTimeline(prompt: string) { return this.generateContent(prompt, [], true); }
  async reviewTimeline(prompt: string) { return this.generateContent(prompt, [], true); }
}
