/**
 * Tracks token usage per provider over a rolling 24-hour window.
 *
 * Design: hourly buckets (24 per provider max) for O(24) reads and O(1) writes.
 * Memory is tiny — even with 6 providers we store at most 144 small objects.
 *
 * This is in-memory only. Counters reset on process restart, which is
 * acceptable for the "free tier usage visibility" use case because cloud
 * providers reset their daily quotas independently.
 */

const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 24;

interface HourlyBucket {
  hour: number; // hours since epoch
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
}

export interface TokenUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
}

export class UsageTracker {
  private buckets = new Map<string, HourlyBucket[]>();

  /** Current hour key (integer, hours since epoch). */
  private currentHour(): number {
    return Math.floor(Date.now() / HOUR_MS);
  }

  /** Keep only buckets within the last WINDOW_HOURS. */
  private prune(existing: HourlyBucket[]): HourlyBucket[] {
    const cutoff = this.currentHour() - WINDOW_HOURS;
    return existing.filter((b) => b.hour > cutoff);
  }

  /** Record a single request's token usage against the current hour bucket. */
  record(providerId: string, promptTokens: number, completionTokens: number): void {
    const now = this.currentHour();
    const fresh = this.prune(this.buckets.get(providerId) ?? []);

    let current = fresh.find((b) => b.hour === now);
    if (!current) {
      current = { hour: now, promptTokens: 0, completionTokens: 0, requestCount: 0 };
      fresh.push(current);
    }
    current.promptTokens += promptTokens;
    current.completionTokens += completionTokens;
    current.requestCount += 1;

    this.buckets.set(providerId, fresh);
  }

  /** Rolling 24-hour totals for a single provider. */
  getTotals(providerId: string): TokenUsageTotals {
    const fresh = this.prune(this.buckets.get(providerId) ?? []);
    const promptTokens = fresh.reduce((s, b) => s + b.promptTokens, 0);
    const completionTokens = fresh.reduce((s, b) => s + b.completionTokens, 0);
    const requestCount = fresh.reduce((s, b) => s + b.requestCount, 0);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      requestCount,
    };
  }

  /** Rolling 24-hour totals for all providers, plus a gateway-wide sum. */
  getAllTotals(): { byProvider: Record<string, TokenUsageTotals>; gateway: TokenUsageTotals } {
    const byProvider: Record<string, TokenUsageTotals> = {};
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalRequests = 0;

    for (const providerId of this.buckets.keys()) {
      const totals = this.getTotals(providerId);
      byProvider[providerId] = totals;
      totalPrompt += totals.promptTokens;
      totalCompletion += totals.completionTokens;
      totalRequests += totals.requestCount;
    }

    return {
      byProvider,
      gateway: {
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens: totalPrompt + totalCompletion,
        requestCount: totalRequests,
      },
    };
  }

  /** Clear all usage data — used by tests or admin reset. */
  reset(): void {
    this.buckets.clear();
  }
}
