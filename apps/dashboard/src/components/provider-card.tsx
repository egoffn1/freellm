import { AlertTriangle, RefreshCw, Clock, Key, Coins, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ProviderCardProps {
  provider: {
    id: string;
    name: string;
    enabled: boolean;
    circuitBreakerState: string;
    successRequests: number;
    failedRequests: number;
    lastError?: string | null;
    lastUsedAt?: string | null;
    keyCount?: number;
    keysAvailable?: number;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      requestCount: number;
    };
    privacy?: {
      policy: string;
      sourceUrl: string;
      lastVerified: string;
    };
  };
  onReset: (providerId: string) => void;
  resetPending: boolean;
}

function getPrivacyStyle(policy: string) {
  switch (policy) {
    case "no-training":
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
    case "local":
      return "bg-sky-500/10 text-sky-400 border-sky-500/20";
    case "configurable":
      return "bg-amber-500/10 text-amber-400 border-amber-500/20";
    case "free-tier-trains":
      return "bg-rose-500/10 text-rose-400 border-rose-500/20";
    default:
      return "bg-muted text-muted-foreground border-border/50";
  }
}

function getPrivacyLabel(policy: string) {
  switch (policy) {
    case "no-training": return "NO-TRAIN";
    case "local": return "LOCAL";
    case "configurable": return "CONFIG";
    case "free-tier-trains": return "TRAINS";
    default: return policy.toUpperCase();
  }
}

function getStatusColor(state: string, enabled: boolean) {
  if (!enabled) return "bg-muted text-muted-foreground border-muted";
  switch (state) {
    case "closed": return "bg-primary/10 text-primary border-primary/15";
    case "open": return "bg-destructive/10 text-destructive border-destructive/15";
    case "half_open": return "bg-amber-500/10 text-amber-400 border-amber-500/15";
    default: return "bg-muted text-muted-foreground border-muted";
  }
}

function getStatusText(state: string, enabled: boolean) {
  if (!enabled) return "Disabled";
  switch (state) {
    case "closed": return "Healthy";
    case "open": return "Failing";
    case "half_open": return "Testing";
    default: return "Unknown";
  }
}

function formatCompact(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function ProviderCard({ provider, onReset, resetPending }: ProviderCardProps) {
  const showReset = provider.circuitBreakerState === "open" || provider.circuitBreakerState === "half_open";
  const keyCount = provider.keyCount ?? 1;
  const keysAvailable = provider.keysAvailable ?? keyCount;
  const hasMultiKey = keyCount > 1;
  const usage = provider.usage;
  const hasTokens = usage && usage.totalTokens > 0;

  return (
    <div className={cn(
      "rounded-xl border border-white/[0.04] bg-card p-5 transition-all duration-200 hover:border-white/[0.08]",
      !provider.enabled && "opacity-50"
    )}>
      {/* Header */}
      <div className="flex justify-between items-start gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="font-mono text-base font-semibold tracking-tight">{provider.name}</h3>
          <p className="text-xs font-mono text-muted-foreground mt-0.5">{provider.id}</p>
        </div>
        <div className="flex flex-wrap items-start gap-1.5 justify-end shrink-0">
          <Badge variant="outline" className={cn("uppercase text-[10px] tracking-wider", getStatusColor(provider.circuitBreakerState, provider.enabled))}>
            {getStatusText(provider.circuitBreakerState, provider.enabled)}
          </Badge>
          {hasMultiKey && (
            <Badge
              variant="outline"
              className="uppercase text-[10px] tracking-wider bg-white/[0.03] text-muted-foreground border-white/[0.06] flex items-center gap-1"
              title={`${keysAvailable}/${keyCount} keys available`}
            >
              <Key className="w-2.5 h-2.5" />
              {keysAvailable}/{keyCount}
            </Badge>
          )}
          {provider.privacy && (
            <a
              href={provider.privacy.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Training policy: ${provider.privacy.policy}\nVerified ${provider.privacy.lastVerified}`}
            >
              <Badge
                variant="outline"
                className={cn(
                  "uppercase text-[10px] tracking-wider flex items-center gap-1 cursor-help",
                  getPrivacyStyle(provider.privacy.policy),
                )}
              >
                <ShieldCheck className="w-2.5 h-2.5" />
                {getPrivacyLabel(provider.privacy.policy)}
              </Badge>
            </a>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-sm font-mono mb-4">
        <div className="flex flex-col gap-0.5 p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Success</span>
          <span className="text-foreground font-medium">{provider.successRequests}</span>
        </div>
        <div className="flex flex-col gap-0.5 p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Failed</span>
          <span className={cn("font-medium", provider.failedRequests > 0 ? "text-destructive" : "text-foreground")}>{provider.failedRequests}</span>
        </div>
      </div>

      {/* Tokens */}
      {hasTokens && usage && (
        <div className="p-3 rounded-lg border border-amber-500/10 bg-amber-500/[0.03] mb-4">
          <div className="flex items-center gap-1.5 text-[10px] uppercase text-amber-400/70 tracking-wider mb-1.5">
            <Coins className="w-3 h-3" /> Tokens (24h)
          </div>
          <div className="font-mono text-sm text-amber-400 font-medium">
            {formatCompact(usage.totalTokens)}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
            in {formatCompact(usage.promptTokens)} · out {formatCompact(usage.completionTokens)}
          </div>
        </div>
      )}

      {/* Error */}
      {provider.lastError && (
        <div className="p-2.5 rounded-lg border border-destructive/10 bg-destructive/[0.03] text-xs text-destructive/80 flex items-start gap-2 overflow-hidden mb-4">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="truncate" title={provider.lastError}>{provider.lastError}</span>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 border-t border-white/[0.04]">
        <div className="text-xs text-muted-foreground font-mono flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          {provider.lastUsedAt ? new Date(provider.lastUsedAt).toLocaleTimeString() : "Never"}
        </div>
        {showReset && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onReset(provider.id)}
            disabled={resetPending}
            className="h-7 text-xs rounded-lg border-amber-500/20 text-amber-400 hover:bg-amber-500/10 hover:text-amber-400"
          >
            <RefreshCw className={cn("w-3 h-3 mr-1", resetPending && "animate-spin")} /> Reset
          </Button>
        )}
      </div>
    </div>
  );
}
