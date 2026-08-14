import { workerJobSchema, workerProgressSchema, workerRenderHandoffSchema, workerTimelineSubmissionSchema } from "../shared/workerProtocol";

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Uses numeric collation so that 2.jpg correctly precedes 10.jpg before a worker computes hashes or calls Gemini. */
export function compareNaturalFilenames(left: string, right: string) {
  return naturalCollator.compare(left, right);
}

export function getWorkerCapabilities() {
  return {
    runner: "VisualSync local worker",
    stages: ["ingest_media", "analyze_audio", "analyze_images", "build_faiss_index", "build_timeline", "review_timeline", "render_mp4"],
    guarantees: [
      "Natural numeric ordering is established before image analysis.",
      "Perceptual and content hashes are attached before cache lookup.",
      "FAISS is the required local semantic index.",
      "The current Gemini Flash release is used through the Interactions API.",
      "FFmpeg renders only a validated variable-duration timeline.",
      "A render handoff requires an explicit approved timeline review.",
    ],
  } as const;
}

export const workerPayloadSchemas = {
  job: workerJobSchema,
  progress: workerProgressSchema,
  timelineSubmission: workerTimelineSubmissionSchema,
  renderHandoff: workerRenderHandoffSchema,
};
