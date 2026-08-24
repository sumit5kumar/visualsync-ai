export function isAmbiguousHeartbeatUpdateTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Heartbeat UpdateHeartbeatJob failed \(500\): .*(context deadline exceeded|stream terminated by RST_STREAM with error code:\s*CANCEL)/i.test(message);
}
