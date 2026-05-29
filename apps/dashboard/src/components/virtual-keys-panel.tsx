import type { VirtualKeySummary } from "@/api/schemas";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useVirtualKeys } from "@/hooks/virtual-keys";
import { cn } from "@/lib/utils";
import { AlertTriangle, Clock, KeyRound, Package } from "lucide-react";

function formatCompact(n: number | null): string {
  if (n == null) return "—";
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

interface ProgressBarProps {
  used: number;
  cap: number | null;
  tint: "emerald" | "amber";
}

function ProgressBar({ used, cap, tint }: ProgressBarProps) {
  if (cap == null) {
    return (
      <div className="font-mono text-xs text-muted-foreground">
        {formatCompact(used)} / unlimited
      </div>
    );
  }
  const pct = Math.min(100, Math.round((used / cap) * 100));
  const trackColor = tint === "emerald" ? "bg-emerald-500/15" : "bg-amber-500/15";
  const fillColor =
    pct >= 90 ? "bg-rose-500" : tint === "emerald" ? "bg-emerald-500" : "bg-amber-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between font-mono text-xs">
        <span className="text-muted-foreground">
          {formatCompact(used)} / {formatCompact(cap)}
        </span>
        <span className={cn(pct >= 90 ? "text-rose-500" : "text-muted-foreground")}>{pct}%</span>
      </div>
      <div className={cn("h-1.5 rounded-full overflow-hidden", trackColor)}>
        <div className={cn("h-full transition-all", fillColor)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function VirtualKeyRow({ vk }: { vk: VirtualKeySummary }) {
  return (
    <div className="p-4 rounded-md border border-border/40 bg-secondary/20 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">{vk.label}</div>
          <div className="font-mono text-[11px] text-muted-foreground mt-0.5 truncate">
            {vk.maskedId}
          </div>
        </div>
        {vk.expired && (
          <Badge
            variant="outline"
            className="bg-rose-500/10 text-rose-500 border-rose-500/30 uppercase text-[10px] tracking-wider"
          >
            Expired
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
            <Package className="w-3 h-3" /> Requests (24h)
          </div>
          <ProgressBar used={vk.requestsInWindow} cap={vk.dailyRequestCap} tint="emerald" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
            <Package className="w-3 h-3" /> Tokens (24h)
          </div>
          <ProgressBar used={vk.tokensInWindow} cap={vk.dailyTokenCap} tint="amber" />
        </div>
      </div>

      {vk.allowedModels && vk.allowedModels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1 self-center">
            Models
          </span>
          {vk.allowedModels.map((m) => (
            <Badge
              key={m}
              variant="outline"
              className="font-mono text-[10px] bg-secondary/50 border-border/50"
            >
              {m}
            </Badge>
          ))}
        </div>
      )}

      {vk.expiresAt && !vk.expired && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="w-3 h-3" />
          Expires {new Date(vk.expiresAt).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}

export function VirtualKeysPanel() {
  const { data, isLoading, isError } = useVirtualKeys();

  // No admin session, no data, or endpoint not mounted yet.
  // Render nothing so operators who do not use virtual keys see no clutter.
  if (isLoading) return null;
  if (isError || !data) return null;
  if (data.count === 0) return null;

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="pb-3 border-b border-border/30">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 font-mono">
              <KeyRound className="w-4 h-4" /> Virtual Keys
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              {data.count} loaded from config
            </CardDescription>
          </div>
          <div
            className="flex items-start gap-1.5 p-2 rounded-md border border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-500 max-w-sm"
            title={data.softCapWarning}
          >
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            <span className="leading-snug">Soft caps. Reset on process restart.</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-4 space-y-3">
        {data.keys.map((vk) => (
          <VirtualKeyRow key={vk.maskedId} vk={vk} />
        ))}
      </CardContent>
    </Card>
  );
}
