import { useState } from "react";
import { useLocation } from "wouter";
import { History as HistoryIcon, Trash2, Search, Clock, Hash, ArrowRight, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface HistoryEntry {
  query: string;
  count: number;
  ts: number;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem("gh_dork_history");
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function clearHistory() {
  localStorage.removeItem("gh_dork_history");
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

export function SearchHistory() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [entries, setEntries] = useState<HistoryEntry[]>(loadHistory);

  const handleClear = () => {
    clearHistory();
    setEntries([]);
    toast({ description: "Search history cleared." });
  };

  const handleRerun = (q: string) => {
    sessionStorage.setItem("gh_dork_rerun", q);
    sessionStorage.setItem("gh_dork_rerun_active", q);
    setLocation("/");
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HistoryIcon className="w-4 h-4 text-primary" />
          <h1 className="text-sm font-mono font-bold text-foreground">Search History</h1>
          {entries.length > 0 && (
            <span className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {entries.length}
            </span>
          )}
        </div>
        {entries.length > 0 && (
          <Button
            data-testid="button-clear-history"
            variant="outline"
            size="sm"
            onClick={handleClear}
            className="gap-1.5 font-mono text-xs text-destructive hover:text-destructive border-destructive/20 hover:border-destructive/40 hover:bg-destructive/5"
          >
            <Trash2 className="w-3 h-3" />
            Clear All
          </Button>
        )}
      </div>

      {entries.length === 0 ? (
        <div
          data-testid="history-empty-state"
          className="bg-card border border-border rounded p-12 text-center"
        >
          <HistoryIcon className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
          <div className="text-sm font-mono text-muted-foreground">No search history yet</div>
          <div className="text-xs text-muted-foreground mt-2">
            Your searches will appear here automatically
          </div>
          <Button
            data-testid="button-go-search"
            variant="outline"
            size="sm"
            onClick={() => setLocation("/")}
            className="mt-4 font-mono text-xs gap-1.5"
          >
            <Search className="w-3 h-3" />
            Start Searching
          </Button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry, idx) => (
            <div
              key={`${entry.ts}-${idx}`}
              data-testid={`history-entry-${idx}`}
              className="bg-card border border-border rounded px-3 py-2.5 flex items-center gap-3 group hover:border-primary/20 transition-colors"
            >
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div
                  className="text-xs font-mono text-foreground truncate"
                  title={entry.query}
                >
                  {entry.query}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                    <Clock className="w-2.5 h-2.5" />
                    {formatRelative(entry.ts)}
                  </span>
                  <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                    <Hash className="w-2.5 h-2.5" />
                    {entry.count.toLocaleString()} results
                  </span>
                </div>
              </div>
              <Button
                data-testid={`button-rerun-${idx}`}
                variant="ghost"
                size="sm"
                onClick={() => handleRerun(entry.query)}
                className="opacity-0 group-hover:opacity-100 transition-opacity font-mono text-xs gap-1 text-primary hover:text-primary hover:bg-primary/10"
              >
                Re-run
                <ArrowRight className="w-3 h-3" />
              </Button>
            </div>
          ))}

          <div
            data-testid="history-limit-note"
            className="flex items-center gap-2 text-xs font-mono text-muted-foreground/60 pt-1 px-1"
          >
            <AlertTriangle className="w-3 h-3 shrink-0" />
            History is stored locally in your browser. Last 50 searches retained.
          </div>
        </div>
      )}
    </div>
  );
}
