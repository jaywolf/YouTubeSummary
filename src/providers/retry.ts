import { AppError } from "../domain/errors";
import type { Sleep } from "./types";

const RETRYABLE_CODES = new Set([
  "network_unavailable",
  "network_timeout",
  "rate_limited",
  "provider_unavailable"
]);

export const defaultSleep: Sleep = async (milliseconds, signal) => {
  if (signal.aborted) throw signal.reason;
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal.reason ?? new DOMException("Canceled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => {
      if (signal.aborted) abort();
    });
  });
};

export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  outputByteCount: () => number,
  signal: AbortSignal,
  sleep: Sleep = defaultSleep
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const retryAfter = error.retryAfterSeconds ?? 0;
      const mayRetry = attempt === 0
        && outputByteCount() === 0
        && error.retryable
        && RETRYABLE_CODES.has(error.code)
        && retryAfter <= 60;
      if (!mayRetry) throw error;
      await sleep(retryAfter * 1_000, signal);
    }
  }
  throw new Error("Unreachable retry state");
}
