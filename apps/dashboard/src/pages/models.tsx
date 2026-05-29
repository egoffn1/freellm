import { getListModelsQueryKey, useListModels } from "@/api/hooks";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Check, Copy, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="p-1.5 rounded-lg hover:bg-white/[0.06] text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer"
      title="Copy model ID"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  groq: "Groq",
  gemini: "Gemini",
  mistral: "Mistral",
  cerebras: "Cerebras",
  ollama: "Ollama",
  freellm: "FreeLLM Meta",
};

export default function Models() {
  const [search, setSearch] = useState("");
  const { data: models, isLoading } = useListModels({
    query: {
      refetchInterval: 30000,
      queryKey: getListModelsQueryKey(),
    },
  });

  const allModels = models?.data ?? [];

  const filtered = search
    ? allModels.filter(
        (m) =>
          m.id.toLowerCase().includes(search.toLowerCase()) ||
          m.provider.toLowerCase().includes(search.toLowerCase()),
      )
    : allModels;

  const grouped = filtered.reduce<Record<string, typeof filtered>>((acc, m) => {
    const p = m.provider ?? "unknown";
    if (!acc[p]) acc[p] = [];
    acc[p].push(m);
    return acc;
  }, {});

  const providerOrder = ["freellm", "groq", "gemini", "mistral", "cerebras", "ollama"];
  const sortedGroups = Object.entries(grouped).sort(([a], [b]) => {
    const ai = providerOrder.indexOf(a);
    const bi = providerOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-mono font-semibold tracking-tight flex items-center gap-3">
            Models
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            All models available through the gateway, grouped by provider.
          </p>
        </div>
        <Badge
          variant="outline"
          className="mt-1 font-mono text-xs border-primary/15 text-primary bg-primary/5 rounded-lg"
        >
          {allModels.length} total
        </Badge>
      </div>

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter models..."
          className="pl-10 font-mono bg-card border-white/[0.06] rounded-xl focus-visible:ring-primary/20 h-11"
        />
      </div>

      {isLoading ? (
        <div className="space-y-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse space-y-2">
              <div className="h-4 w-24 bg-muted rounded-lg" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {[1, 2, 3].map((j) => (
                  <div key={j} className="h-14 bg-card rounded-xl" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : sortedGroups.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground font-mono text-sm">
          No models found.
        </div>
      ) : (
        <div className="space-y-8">
          {sortedGroups.map(([provider, providerModels]) => (
            <div key={provider}>
              <div className="flex items-center gap-3 mb-3">
                <h2 className="text-xs font-mono font-semibold uppercase tracking-widest text-muted-foreground">
                  {PROVIDER_LABELS[provider] ?? provider}
                </h2>
                <div className="flex-1 h-px bg-white/[0.04]" />
                <span className="text-xs font-mono text-muted-foreground/60">
                  {providerModels.length}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                {providerModels.map((model) => (
                  <div
                    key={model.id}
                    className={cn(
                      "group rounded-xl border border-white/[0.04] bg-card hover:border-white/[0.08] transition-colors duration-150 cursor-pointer",
                      provider === "freellm" &&
                        "border-primary/10 bg-primary/[0.03] hover:border-primary/20",
                    )}
                  >
                    <div className="p-3.5 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "font-mono text-sm truncate",
                            provider === "freellm"
                              ? "text-primary font-semibold"
                              : "text-foreground",
                          )}
                          title={model.id}
                        >
                          {model.id}
                        </p>
                        <p className="text-[11px] text-muted-foreground/60 font-mono mt-0.5">
                          {model.object}
                        </p>
                      </div>
                      <CopyButton value={model.id} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
