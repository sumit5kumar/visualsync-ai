/**
 * Multi-provider selection (Phase 1).
 *
 * Each project chooses one transcription provider and one vision & sync
 * provider. Groq stays a first-class, selectable option for both. Providers
 * whose processing path is not wired yet are visible in the UI but the hosted
 * job refuses them up-front with a clear message, so a project can never be
 * half-processed by an unfinished engine.
 */
export const TRANSCRIPTION_PROVIDER_IDS = ["GROQ_WHISPER", "DEEPGRAM_NOVA2", "LOCAL_FASTER_WHISPER"] as const;
export const VISION_SYNC_PROVIDER_IDS = ["GROQ", "GEMINI_FLASH"] as const;
export type TranscriptionProviderId = (typeof TRANSCRIPTION_PROVIDER_IDS)[number];
export type VisionSyncProviderId = (typeof VISION_SYNC_PROVIDER_IDS)[number];

export const DEFAULT_TRANSCRIPTION_PROVIDER: TranscriptionProviderId = "GROQ_WHISPER";
export const DEFAULT_VISION_SYNC_PROVIDER: VisionSyncProviderId = "GROQ";

export type ProviderAvailability = "ready" | "coming_soon" | "requires_local_server";

export type ProviderDescriptor<Id extends string> = {
  id: Id;
  label: string;
  description: string;
  availability: ProviderAvailability;
  /** Phase in which this provider's processing path is wired end-to-end. */
  wiredInPhase: number;
  keyPool: "groq" | "gemini" | "deepgram" | "none";
};

export const TRANSCRIPTION_PROVIDERS: readonly ProviderDescriptor<TranscriptionProviderId>[] = [
  { id: "GROQ_WHISPER", label: "Groq Whisper (30s Chunking)", description: "whisper-large-v3 with word timestamps; long narration is split into 30-second windows. Uses the Groq key rotation pool.", availability: "ready", wiredInPhase: 0, keyPool: "groq" },
  { id: "DEEPGRAM_NOVA2", label: "Deepgram Nova-2", description: "Single-shot long-audio transcription with word timestamps (no chunk seams). Requires DEEPGRAM_API_KEY on the server.", availability: "ready", wiredInPhase: 2, keyPool: "deepgram" },
  { id: "LOCAL_FASTER_WHISPER", label: "Local GPU (Faster-Whisper)", description: "Your own GPU server running faster-whisper, plugged in through LOCAL_WHISPER_URL. The hosted site must be able to reach that server (for example through a tunnel).", availability: "requires_local_server", wiredInPhase: 2, keyPool: "none" },
];

export const VISION_SYNC_PROVIDERS: readonly ProviderDescriptor<VisionSyncProviderId>[] = [
  { id: "GROQ", label: "Groq", description: "Current working Groq image analysis and timeline sync. Uses the Groq key rotation pool.", availability: "ready", wiredInPhase: 0, keyPool: "groq" },
  { id: "GEMINI_FLASH", label: "Gemini Flash", description: "Batch vision (8 images per request) plus global-context sync with header, || separator and pool splitting. Uses the Gemini key rotation pool. Processing is enabled in Phases 3–4.", availability: "coming_soon", wiredInPhase: 3, keyPool: "gemini" },
];

/** Highest phase whose processing paths are live in this build. Raise it as each phase lands. */
export const CURRENT_PROVIDER_PHASE = 4;

export function isTranscriptionProviderId(value: unknown): value is TranscriptionProviderId {
  return typeof value === "string" && (TRANSCRIPTION_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isVisionSyncProviderId(value: unknown): value is VisionSyncProviderId {
  return typeof value === "string" && (VISION_SYNC_PROVIDER_IDS as readonly string[]).includes(value);
}

export function describeTranscriptionProvider(id: TranscriptionProviderId) {
  return TRANSCRIPTION_PROVIDERS.find(provider => provider.id === id)!;
}

export function describeVisionSyncProvider(id: VisionSyncProviderId) {
  return VISION_SYNC_PROVIDERS.find(provider => provider.id === id)!;
}

export type ProviderSelection = { transcriptionProvider: TranscriptionProviderId; visionSyncProvider: VisionSyncProviderId };

/** Returns a human-readable blocker when the selected providers cannot process a project in this build. */
export function providerSelectionBlocker(selection: ProviderSelection, phase = CURRENT_PROVIDER_PHASE, env: { localWhisperUrl?: string } = {}): string | null {
  const transcription = describeTranscriptionProvider(selection.transcriptionProvider);
  const vision = describeVisionSyncProvider(selection.visionSyncProvider);
  if (transcription.id === "LOCAL_FASTER_WHISPER" && !env.localWhisperUrl) return `${transcription.label} is selected, but LOCAL_WHISPER_URL is not configured on the server. Choose Groq Whisper (30s Chunking) or configure the local GPU server address.`;
  if (transcription.wiredInPhase > phase) return `${transcription.label} transcription is selectable but its processing path is enabled in Phase ${transcription.wiredInPhase}. Choose Groq Whisper (30s Chunking) for this project for now.`;
  if (vision.wiredInPhase > phase) return `${vision.label} vision & sync is selectable but its processing path is enabled in Phase ${vision.wiredInPhase}. Choose Groq for this project for now.`;
  return null;
}

export function providerCatalog(phase = CURRENT_PROVIDER_PHASE) {
  const withState = <Id extends string>(provider: ProviderDescriptor<Id>) => ({ ...provider, processingEnabled: provider.wiredInPhase <= phase });
  return {
    phase,
    transcription: TRANSCRIPTION_PROVIDERS.map(withState),
    visionSync: VISION_SYNC_PROVIDERS.map(withState),
    defaults: { transcriptionProvider: DEFAULT_TRANSCRIPTION_PROVIDER, visionSyncProvider: DEFAULT_VISION_SYNC_PROVIDER },
  };
}
