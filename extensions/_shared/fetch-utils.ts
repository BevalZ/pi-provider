/**
 * Shared fetch-with-timeout utility for Pi extensions.
 *
 * Usage:
 *   import { fetchWithTimeout } from "../_shared/fetch-utils";
 *   const resp = await fetchWithTimeout(url, { method: "GET" }, 10_000, ctx.signal);
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  url: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  upstreamSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const cleanup: Array<() => void> = [];

  // Merge external signals
  for (const signal of [init.signal, upstreamSignal]) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      continue;
    }
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    cleanup.push(() => signal.removeEventListener("abort", abort));
  }

  const cleanUp = () => {
    clearTimeout(timeout);
    for (const removeListener of cleanup.splice(0)) removeListener();
  };
  const timeout = setTimeout(() => {
    controller.abort();
    cleanUp();
  }, timeoutMs);
  timeout.unref?.();

  try {
    // Strip signal from init to avoid conflicts — ours is the merged one.
    // Keep the timer alive after headers so stalled response bodies are aborted too.
    const { signal: _s, headers, ...rest } = init;
    const response = await fetch(url, {
      ...rest,
      headers: headers as HeadersInit | undefined,
      signal: controller.signal,
    });
    if (!response.body) cleanUp();
    return response;
  } catch (error) {
    cleanUp();
    throw error;
  }
}
