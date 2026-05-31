import { useState } from "react";
import {
  Terminal,
  Download,
  Copy,
  CheckCircle,
  Key,
  Wallet,
  Layers,
  FileCode,
  Cloud,
  ShieldAlert,
  Star,
  AlertTriangle,
  Code2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  { icon: Key,         color: "text-orange-400", name: "Private Keys",               count: 15 },
  { icon: Wallet,      color: "text-yellow-400", name: "Seed Phrases & Mnemonics",   count: 10 },
  { icon: Star,        color: "text-red-400",    name: "Exchange API Keys",           count: 12 },
  { icon: FileCode,    color: "text-blue-400",   name: "Wallet Configuration Files", count: 8 },
  { icon: Layers,      color: "text-cyan-400",   name: "Web3 Framework Files",       count: 8 },
  { icon: Cloud,       color: "text-sky-400",    name: "RPC & Node Credentials",     count: 6 },
  { icon: ShieldAlert, color: "text-purple-400", name: "Payment Gateways",           count: 4 },
  { icon: FileCode,    color: "text-zinc-400",   name: "Backup & Exposed Files",     count: 6 },
];

const EXAMPLES = [
  {
    label: "Run all 69 queries, export markdown",
    cmd: "GITHUB_TOKEN=ghp_xxx node index.js --all --format md --output report.md",
  },
  {
    label: "Scan private keys only, with validation",
    cmd: 'GITHUB_TOKEN=ghp_xxx node index.js --category "Private Keys" --validate',
  },
  {
    label: "Multi-token rotation (avoids rate limits)",
    cmd: "TOKEN_ARRAY=ghp_a,ghp_b,ghp_c node index.js --all --delay 800 --format csv",
  },
  {
    label: "Scope scan to a specific GitHub user",
    cmd: 'GITHUB_TOKEN=ghp_xxx node index.js --category "Exchange API Keys" --scope targetuser',
  },
  {
    label: "Custom single query",
    cmd: "GITHUB_TOKEN=ghp_xxx node index.js --query 'filename:.env \"PRIVATE_KEY\" solana'",
  },
  {
    label: "List available categories",
    cmd: "node index.js --list-categories",
  },
];

const ENV_VARS = [
  { name: "GITHUB_TOKEN", desc: "Single GitHub PAT (classic). Needs repo scope." },
  { name: "TOKEN_ARRAY",  desc: "Comma-separated tokens for automatic rotation." },
];

const OPTIONS = [
  ["--all",              "Run all 69 dork queries"],
  ["--category <name>",  "Run a specific category"],
  ["--query <q>",        "Run a single custom search query"],
  ["--scope <user|org>", "Scope searches to a GitHub user or org"],
  ["--validate",         "Enable 2-layer credential validation"],
  ["--format <type>",    "Output: json | csv | txt | md (default: json)"],
  ["--output <file>",    "Output file path (auto-named if omitted)"],
  ["--delay <ms>",       "Delay between requests (default: 1200ms)"],
  ["--max-results <n>",  "Results per query, max 100 (default: 30)"],
  ["--list-categories",  "List all categories and query counts"],
  ["--verbose",          "Debug/verbose logging"],
];

export function Cli() {
  const { toast } = useToast();
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const handleCopy = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
    toast({ description: "Command copied." });
  };

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = `${import.meta.env.BASE_URL}ghdork-cli.js`;
    a.download = "index.js";
    a.click();
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Terminal className="w-4 h-4 text-primary" />
            <h1 className="text-sm font-mono font-bold text-foreground">CLI Tool</h1>
          </div>
          <p className="text-xs text-muted-foreground font-mono">
            Node.js 18+ • Single file • No dependencies • 69 dork queries
          </p>
        </div>
        <Button
          data-testid="button-download-cli"
          onClick={handleDownload}
          className="gap-1.5 font-mono text-xs shrink-0"
          size="sm"
        >
          <Download className="w-3.5 h-3.5" />
          Download index.js
        </Button>
      </div>

      {/* Quick start */}
      <div className="bg-card border border-border rounded p-4 space-y-3">
        <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest">Quick Start</div>
        <div className="space-y-2">
          {["# Node.js 18+ required", "GITHUB_TOKEN=ghp_xxxx node index.js --all"].map((line, i) => (
            <div key={i} className="flex items-center gap-2">
              <pre className={cn(
                "bg-background rounded px-3 py-2 text-xs font-mono flex-1 border border-border/50",
                line.startsWith("#") ? "text-muted-foreground" : "text-primary"
              )}>{line}</pre>
              {!line.startsWith("#") && (
                <button
                  data-testid={`button-copy-quickstart-${i}`}
                  onClick={() => handleCopy(line, i)}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {copiedIdx === i
                    ? <CheckCircle className="w-3.5 h-3.5 text-primary" />
                    : <Copy className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Dork categories */}
      <div className="space-y-2">
        <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest px-1">
          Dork Categories — 69 total queries
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            return (
              <div
                key={cat.name}
                data-testid={`category-info-${cat.name.replace(/\s+/g, "-")}`}
                className="bg-card border border-border rounded px-3 py-2 flex items-center gap-2"
              >
                <Icon className={cn("w-3 h-3 shrink-0", cat.color)} />
                <span className="text-xs font-mono text-muted-foreground flex-1 truncate">{cat.name}</span>
                <span className="text-xs font-mono text-primary shrink-0">{cat.count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Examples */}
      <div className="space-y-2">
        <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest px-1">Examples</div>
        <div className="space-y-1.5">
          {EXAMPLES.map((ex, i) => (
            <div key={i} className="bg-card border border-border rounded p-3 space-y-1.5">
              <div className="text-xs font-mono text-muted-foreground">{ex.label}</div>
              <div className="flex items-center gap-2">
                <pre className="flex-1 bg-background rounded px-2 py-1.5 text-xs font-mono text-primary border border-border/50 overflow-x-auto whitespace-pre">
                  {ex.cmd}
                </pre>
                <button
                  data-testid={`button-copy-example-${i}`}
                  onClick={() => handleCopy(ex.cmd, 100 + i)}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {copiedIdx === 100 + i
                    ? <CheckCircle className="w-3.5 h-3.5 text-primary" />
                    : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Options table */}
      <div className="space-y-2">
        <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest px-1">Options</div>
        <div className="bg-card border border-border rounded divide-y divide-border">
          {OPTIONS.map(([flag, desc]) => (
            <div key={flag} className="flex items-center gap-3 px-3 py-2">
              <code className="text-xs font-mono text-primary shrink-0 w-44">{flag}</code>
              <span className="text-xs font-mono text-muted-foreground">{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Env vars */}
      <div className="space-y-2">
        <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest px-1">Environment Variables</div>
        <div className="bg-card border border-border rounded divide-y divide-border">
          {ENV_VARS.map((v) => (
            <div key={v.name} className="flex items-center gap-3 px-3 py-2">
              <code className="text-xs font-mono text-yellow-400 shrink-0 w-36">{v.name}</code>
              <span className="text-xs font-mono text-muted-foreground">{v.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Architecture note */}
      <div className="bg-card border border-border rounded p-4 space-y-2">
        <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
          <Code2 className="w-3.5 h-3.5 text-primary" />
          <span className="uppercase tracking-widest">Architecture</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[
            ["GitHubClient", "API calls, rate limiting, token rotation"],
            ["DorkManager", "69 dork query definitions across 8 categories"],
            ["CredentialValidator", "Heuristic + regex format validation"],
            ["ResultExporter", "JSON / CSV / TXT / Markdown output"],
          ].map(([cls, desc]) => (
            <div key={cls} className="bg-background rounded px-2.5 py-2 border border-border/50">
              <div className="text-xs font-mono text-primary">{cls}</div>
              <div className="text-xs font-mono text-muted-foreground mt-0.5">{desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Legal notice */}
      <div className="flex items-start gap-2 text-xs font-mono text-muted-foreground/60 bg-yellow-400/5 border border-yellow-400/10 rounded px-3 py-2.5">
        <AlertTriangle className="w-3.5 h-3.5 text-yellow-400/70 shrink-0 mt-0.5" />
        <span>
          For security research and authorized auditing only. Only scan repos you own
          or have explicit written permission to audit.
        </span>
      </div>
    </div>
  );
}
