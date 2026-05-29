import { ShieldCheck, ShieldOff, BookOpen, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Dashboard card surfacing the FREELLM_TOKEN_SECRET boot state.
 *
 * Browser tokens are stateless by design, so there is no per-request
 * state to render here. The one thing an operator cannot see anywhere
 * else is whether they remembered to configure the secret. This card
 * answers that question in one glance and links out to the docs.
 */
interface BrowserTokensCardProps {
  info: {
    enabled: boolean;
    minSecretBytes: number;
    maxTtlSeconds: number;
  };
}

const DOCS_URL = "https://freellms.vercel.app/browser-integration/";

export function BrowserTokensCard({ info }: BrowserTokensCardProps) {
  const Icon = info.enabled ? ShieldCheck : ShieldOff;

  return (
    <Card
      className={cn(
        "overflow-hidden border-white/[0.04] bg-card transition-colors duration-200 w-full lg:max-w-md",
      )}
    >
      <CardHeader className="pb-3 border-b border-white/[0.04]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn(
                "flex items-center justify-center w-9 h-9 rounded-md shrink-0 transition-colors duration-200",
                info.enabled
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <Icon className="w-4 h-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <CardTitle className="font-mono text-base">Browser Tokens</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Stateless short-lived tokens for static sites
              </CardDescription>
            </div>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "uppercase text-[10px] tracking-wider flex items-center gap-1 shrink-0",
              info.enabled
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/15"
                : "bg-muted text-muted-foreground border-white/[0.06]",
            )}
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                info.enabled
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-muted-foreground",
              )}
              aria-hidden="true"
            />
            {info.enabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-4 space-y-3">
        <div className="grid grid-cols-2 gap-2 text-sm font-mono">
          <div className="flex flex-col p-2 bg-white/[0.02] rounded-lg border border-white/[0.04]">
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
              Max TTL
            </span>
            <span className="text-foreground tabular-nums">
              {Math.floor(info.maxTtlSeconds / 60)} min
            </span>
          </div>
          <div className="flex flex-col p-2 bg-white/[0.02] rounded-lg border border-white/[0.04]">
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
              Min secret
            </span>
            <span className="text-foreground tabular-nums">
              {info.minSecretBytes} bytes
            </span>
          </div>
        </div>

        {!info.enabled && (
          <div className="flex items-start gap-2 p-2 rounded-md border border-amber-500/20 bg-amber-500/5 text-[11px] text-amber-500 leading-snug">
            <ShieldOff className="w-3 h-3 mt-0.5 shrink-0" strokeWidth={1.75} />
            <span>
              Set <span className="font-mono">FREELLM_TOKEN_SECRET</span> to at least{" "}
              <span className="font-mono">{info.minSecretBytes}</span> bytes and restart to
              enable issuing browser-safe tokens.
            </span>
          </div>
        )}

        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "group flex items-center justify-between px-3 py-2 rounded-md",
            "border border-white/[0.04] bg-white/[0.02] hover:bg-white/[0.04]",
            "text-xs font-mono text-muted-foreground hover:text-foreground",
            "transition-colors duration-200 cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
          aria-label="Browser integration guide (opens in new tab)"
        >
          <span className="flex items-center gap-2">
            <BookOpen className="w-3 h-3" strokeWidth={1.75} />
            Browser integration guide
          </span>
          <ExternalLink
            className="w-3 h-3 opacity-60 group-hover:opacity-100 transition-opacity"
            strokeWidth={1.75}
          />
        </a>
      </CardContent>
    </Card>
  );
}
