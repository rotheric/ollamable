export const DISCOVERY_TIMEOUT_MS = 10_000;
export const TOOL_REQUEST_TIMEOUT_MS = 20_000;

/** Keep the deadline alive through body consumption, not just response headers. */
export async function withNetworkDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error(`Network request timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref();
  try {
    signal.throwIfAborted();
    return await operation(signal);
  } finally {
    clearTimeout(timer);
  }
}
