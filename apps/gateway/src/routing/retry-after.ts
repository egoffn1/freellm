/**
 * Parse an upstream `Retry-After` header into a millisecond cooldown
 * that is safe to use as a provider-specific backoff.
 *
 * RFC 9110 allows two formats:
 *   1. A non-negative integer number of seconds ("120")
 *   2. An HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT")
 *
 * We accept both, plus the fractional-seconds variant some providers
 * emit in the wild ("1.5"). The result is clamped to a safe window:
 *
 *   [MIN_RETRY_MS, MAX_RETRY_MS] = [1s, 10min]
 *
 * Why clamp? Groq has been observed sending values like "99999999"
 * during incidents, which would lock a key out for years. And some
 * upstreams return "0" or negative values which would cause a tight
 * retry loop. Clamping is belt and suspenders.
 *
 * Returns null if the header is missing or entirely unparseable, so
 * callers can fall back to their own default cooldown.
 */

export const MIN_RETRY_MS = 1_000; //          1 second floor
export const MAX_RETRY_MS = 600_000; //        10 minute ceiling

export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (header == null) return null;
  const raw = header.trim();
  if (raw.length === 0) return null;

  // Case 1: numeric seconds (integer or fractional).
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const seconds = parseFloat(raw);
    if (!Number.isFinite(seconds)) return null;
    return clamp(seconds * 1_000);
  }

  // Case 2: HTTP-date. Date.parse returns NaN on failure.
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  return clamp(dateMs - now);
}

function clamp(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_RETRY_MS;
  if (ms < MIN_RETRY_MS) return MIN_RETRY_MS;
  if (ms > MAX_RETRY_MS) return MAX_RETRY_MS;
  return Math.round(ms);
}

/** Convert a clamped millisecond value to the `Retry-After` header seconds. */
export function toRetryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1_000));
}
