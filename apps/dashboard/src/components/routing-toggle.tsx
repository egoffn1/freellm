import { ArrowRightLeft } from "lucide-react";
import { Switch } from "@/components/ui/switch";

interface RoutingToggleProps {
  strategy: string | undefined;
  onToggle: (checked: boolean) => void;
  disabled: boolean;
}

export function RoutingToggle({ strategy, onToggle, disabled }: RoutingToggleProps) {
  return (
    <div className="flex items-center gap-3 bg-card border border-white/[0.04] px-3.5 py-2.5 rounded-xl self-start sm:self-auto">
      <span className="text-sm font-medium text-muted-foreground flex items-center gap-2">
        <ArrowRightLeft className="w-4 h-4 shrink-0" />
        <span className="hidden sm:inline">Routing:</span>
        <span className="text-foreground uppercase tracking-widest text-xs font-mono">
          {strategy?.replace("_", " ")}
        </span>
      </span>
      <Switch
        checked={strategy === "round_robin"}
        onCheckedChange={onToggle}
        disabled={disabled}
        className="data-[state=checked]:bg-primary"
      />
    </div>
  );
}
