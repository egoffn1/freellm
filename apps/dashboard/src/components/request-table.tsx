import { ArrowDownUp, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface RequestEntry {
  id: string;
  timestamp: string;
  status: string;
  requestedModel: string;
  provider?: string | null;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  cached?: boolean;
}

interface RequestTableProps {
  requests: RequestEntry[];
}

function StatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return <Badge variant="outline" className="bg-primary/5 text-primary border-primary/15 text-[10px] uppercase rounded-md font-normal py-0">OK</Badge>;
  }
  if (status === "rate_limited") {
    return <Badge variant="outline" className="bg-amber-500/5 text-amber-400 border-amber-500/15 text-[10px] uppercase rounded-md font-normal py-0">429</Badge>;
  }
  return <Badge variant="outline" className="bg-destructive/5 text-destructive border-destructive/15 text-[10px] uppercase rounded-md font-normal py-0">ERR</Badge>;
}

export function RequestTable({ requests }: RequestTableProps) {
  return (
    <div>
      <h2 className="text-lg font-mono font-semibold mb-4 flex items-center gap-2 text-foreground">
        <ArrowDownUp className="w-4 h-4 text-muted-foreground" /> Recent Requests
      </h2>
      <div className="rounded-xl border border-white/[0.04] bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-white/[0.04] hover:bg-transparent">
                <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Time</TableHead>
                <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Status</TableHead>
                <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Model</TableHead>
                <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Provider</TableHead>
                <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground font-medium text-right">Tokens</TableHead>
                <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground font-medium text-right">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!requests.length ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="text-center h-28 text-muted-foreground font-mono text-sm">
                    No requests yet. Waiting for traffic...
                  </TableCell>
                </TableRow>
              ) : (
                requests.map((req) => {
                  const hasTokens = req.promptTokens != null || req.completionTokens != null;
                  return (
                    <TableRow key={req.id} className="border-white/[0.03] hover:bg-white/[0.02] transition-colors duration-150 font-mono text-sm">
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                        {new Date(req.timestamp).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 2 })}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={req.status} />
                          {req.cached && (
                            <Badge variant="outline" className="bg-cyan-400/5 text-cyan-400 border-cyan-400/15 text-[10px] uppercase rounded-md font-normal py-0" title="Served from cache">CACHE</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[150px] truncate" title={req.requestedModel}>{req.requestedModel}</TableCell>
                      <TableCell className="text-muted-foreground">{req.provider || "-"}</TableCell>
                      <TableCell className="text-right text-xs whitespace-nowrap">
                        {hasTokens ? (
                          <span className="text-amber-400/70" title={`${req.promptTokens ?? 0} prompt → ${req.completionTokens ?? 0} completion`}>
                            {req.promptTokens ?? 0}<span className="text-muted-foreground/50 mx-0.5">→</span>{req.completionTokens ?? 0}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={cn("inline-flex items-center gap-1", req.latencyMs > 2000 ? "text-amber-400" : "text-muted-foreground")}>
                          {req.latencyMs > 2000 && <Zap className="w-3 h-3" />}
                          {req.latencyMs}ms
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
