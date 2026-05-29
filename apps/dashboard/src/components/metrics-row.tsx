import { Activity, CheckCircle2, XCircle, Coins, Database } from "lucide-react";

interface MetricsRowProps {
  total: number;
  success: number;
  failed: number;
  tokens: number;
  cacheHits: number;
  cacheHitRate: number;
}

/** Compact number formatter: 1234 → "1.2K", 1500000 → "1.5M" */
function formatCompact(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function MetricsRow({ total, success, failed, tokens, cacheHits, cacheHitRate }: MetricsRowProps) {
  const items = [
    {
      label: "Total",
      value: total.toLocaleString(),
      sub: undefined,
      icon: Activity,
      accent: "text-slate-400",
      glow: "",
    },
    {
      label: "Success",
      value: success.toLocaleString(),
      sub: undefined,
      icon: CheckCircle2,
      accent: "text-primary",
      glow: "shadow-[inset_0_1px_0_rgba(45,212,140,0.06)]",
    },
    {
      label: "Failed",
      value: failed.toLocaleString(),
      sub: undefined,
      icon: XCircle,
      accent: "text-destructive",
      glow: failed > 0 ? "shadow-[inset_0_1px_0_rgba(220,80,80,0.06)]" : "",
    },
    {
      label: "Cache Hits",
      value: formatCompact(cacheHits),
      sub: cacheHits > 0 ? `${(cacheHitRate * 100).toFixed(0)}% hit rate` : undefined,
      icon: Database,
      accent: "text-cyan-400",
      glow: "shadow-[inset_0_1px_0_rgba(34,211,238,0.06)]",
    },
    {
      label: "Tokens (24h)",
      value: formatCompact(tokens),
      sub: undefined,
      icon: Coins,
      accent: "text-amber-400",
      glow: "shadow-[inset_0_1px_0_rgba(251,191,36,0.06)]",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      {items.map((item) => (
        <div
          key={item.label}
          className={`rounded-xl border border-white/[0.04] bg-card p-4 ${item.glow} transition-colors duration-200 hover:border-white/[0.08]`}
        >
          <div className="flex items-center gap-2 mb-3">
            <item.icon className={`w-4 h-4 ${item.accent} opacity-70`} />
            <span className="text-xs font-medium text-muted-foreground tracking-wide">
              {item.label}
            </span>
          </div>
          <p className={`text-2xl font-mono font-semibold leading-none ${item.accent}`}>
            {item.value}
          </p>
          {item.sub && (
            <p className="text-[11px] font-mono text-muted-foreground mt-1.5">
              {item.sub}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
