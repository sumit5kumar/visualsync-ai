export type SavedTimelineJob = { status: string } | null | undefined;

/**
 * A gateway can lose the mutation response after the server has already
 * persisted a durable Timeline job. Treat only a non-terminal saved job as
 * recovered; terminal/absent jobs still surface the original mutation error.
 */
export function hasRecoverableSavedTimelineJob(job: SavedTimelineJob) {
  return job?.status === "queued" || job?.status === "processing" || job?.status === "waiting_for_retry";
}
