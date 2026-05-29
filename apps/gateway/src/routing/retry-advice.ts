import { FAST_PRIORITY, SMART_PRIORITY } from "../config.js";
import type { ProviderStatusInfo } from "../types.js";

export interface ProviderRetryHint {
  id: string;
  retry_after_ms: number | null;
  keys_available: number;
  keys_total: number;
  circuit_state: string;
}

export interface ModelSuggestion {
  model: string;
  available_in_ms: number;
}

export interface RetryAdvice {
  retry_after_ms: number | null;
  providers: ProviderRetryHint[];
  suggestions: ModelSuggestion[];
}

/**
 * Earliest moment a key on this provider will become usable again.
 * - If any key is currently available → 0
 * - Else: minimum positive `retryAfterMs` across all keys
 * - Else (cooldown unknown but window full): null
 */
export function providerRetryAfterMs(p: ProviderStatusInfo): number | null {
  if (p.keys.length === 0) return null;
  if (p.keysAvailable > 0) return 0;
  let min: number | null = null;
  for (const k of p.keys) {
    if (k.retryAfterMs == null) continue;
    if (k.retryAfterMs <= 0) return 0;
    if (min == null || k.retryAfterMs < min) min = k.retryAfterMs;
  }
  return min;
}

function hint(p: ProviderStatusInfo): ProviderRetryHint {
  return {
    id: p.id,
    retry_after_ms: providerRetryAfterMs(p),
    keys_available: p.keysAvailable,
    keys_total: p.keyCount,
    circuit_state: p.circuitBreakerState,
  };
}

/**
 * Earliest moment ANY of the given providers will be usable. Returns:
 * - 0 if at least one is currently available
 * - the minimum positive cooldown otherwise
 * - null if no provider can give a deterministic answer
 */
export function earliestRetryMs(providers: ProviderStatusInfo[]): number | null {
  let best: number | null = null;
  for (const p of providers) {
    const ms = providerRetryAfterMs(p);
    if (ms == null) continue;
    if (ms <= 0) return 0;
    if (best == null || ms < best) best = ms;
  }
  return best;
}

/** Suggest a meta-model the caller can try and when it'll be free. */
function suggestMetaModel(
  id: string,
  priority: readonly string[],
  byId: Map<string, ProviderStatusInfo>,
): ModelSuggestion | null {
  const ordered = priority
    .map((pid) => byId.get(pid))
    .filter((p): p is ProviderStatusInfo => !!p && p.enabled);
  if (ordered.length === 0) return null;
  const ms = earliestRetryMs(ordered);
  if (ms == null) return null;
  return { model: id, available_in_ms: ms };
}

/**
 * Build the full retry-advice payload returned in 429 bodies.
 * `attempted` is the set of provider IDs the router actually tried (used
 * to label hints; we still report state for ALL providers so the caller
 * can pick a different model entirely).
 */
export function buildRetryAdvice(
  providers: ProviderStatusInfo[],
  attempted: string[],
): RetryAdvice {
  const enabled = providers.filter((p) => p.enabled);
  const byId = new Map(enabled.map((p) => [p.id, p]));
  const attemptedSet = new Set(attempted);

  // Hints prioritise providers we actually tried — those are the ones
  // the caller cares about — but include all enabled providers for
  // completeness so they can decide to switch model entirely.
  const hints: ProviderRetryHint[] = [
    ...enabled.filter((p) => attemptedSet.has(p.id)).map(hint),
    ...enabled.filter((p) => !attemptedSet.has(p.id)).map(hint),
  ];

  const suggestions: ModelSuggestion[] = [];
  const fast = suggestMetaModel("free-fast", FAST_PRIORITY, byId);
  const smart = suggestMetaModel("free-smart", SMART_PRIORITY, byId);
  if (fast) suggestions.push(fast);
  if (smart) suggestions.push(smart);

  return {
    retry_after_ms: earliestRetryMs(enabled),
    providers: hints,
    suggestions,
  };
}

/** HTTP `Retry-After` header value (seconds, integer). Null if unknown. */
export function retryAfterSeconds(advice: RetryAdvice): number | null {
  if (advice.retry_after_ms == null) return null;
  return Math.max(1, Math.ceil(advice.retry_after_ms / 1000));
}
