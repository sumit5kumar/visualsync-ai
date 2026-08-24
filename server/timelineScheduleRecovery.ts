export function isAmbiguousHeartbeatUpdateTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Heartbeat UpdateHeartbeatJob failed \(500\): .*context deadline exceeded/i.test(message);
}
