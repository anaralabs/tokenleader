/**
 * Build the `signal` for a Cursor API fetch. A caller-supplied signal (e.g. the
 * daemon's shutdown signal) must not *replace* the per-request timeout, or a
 * hung connection would never abort until the whole daemon stops — so combine
 * the two when a caller signal is present.
 */
export function fetchSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
