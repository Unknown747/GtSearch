import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  Copy,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  CheckCircle,
  Key,
  Wallet,
  FileCode,
  Layers,
  ShieldAlert,
  Info,
  Star,
  Clock,
  Zap,
  Send,
  ServerCrash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const DORK_LIBRARY = [
  {
    category: "Wallet & Seed Phrases",
    icon: Wallet,
    color: "text-yellow-400",
    queries: [
      { label: "mnemonic .env",            q: 'filename:.env "MNEMONIC"' },
      { label: "PRIVATE_KEY .env",         q: 'filename:.env "PRIVATE_KEY"' },
      { label: "wallet.json keystore",     q: 'filename:wallet.json "crypto" "ciphertext"' },
      { label: "seed phrase JS",           q: '"bip39" "mnemonic" "entropy"' },
      { label: "recovery.txt",             q: 'filename:recovery.txt "phrase"' },
      { label: "mnemonic.json",            q: 'filename:mnemonic.json' },
      { label: "Trust Wallet mnemonic",    q: '"trustwallet" "mnemonic" extension:json' },
    ],
  },
  {
    category: "Exchange API Keys",
    icon: Key,
    color: "text-red-400",
    queries: [
      { label: "Binance API key",          q: 'filename:.env "BINANCE_API_KEY"' },
      { label: "Coinbase API key",         q: 'filename:.env "COINBASE_API_KEY"' },
      { label: "Kraken key+secret",        q: 'filename:.env "KRAKEN_API_KEY"' },
      { label: "OKX API key",              q: 'filename:.env "OKX_API_KEY"' },
      { label: "KuCoin key",               q: 'filename:.env "KUCOIN_KEY"' },
      { label: "Bybit API key",            q: 'filename:.env "BYBIT_API_KEY"' },
      { label: "Bitget API key",           q: 'filename:.env "BITGET_API_KEY"' },
    ],
  },
  {
    category: "Smart Contract & DeFi",
    icon: Layers,
    color: "text-cyan-400",
    queries: [
      { label: "Hardhat private key",      q: 'filename:hardhat.config.js "PRIVATE_KEY"' },
      { label: "Hardhat TS mnemonic",      q: 'filename:hardhat.config.ts "mnemonic"' },
      { label: "Truffle mnemonic",         q: 'filename:truffle-config.js "mnemonic"' },
      { label: "Foundry private_key",      q: 'filename:foundry.toml "private_key"' },
      { label: "deployer key",             q: '"DEPLOYER_PRIVATE_KEY" filename:.env' },
      { label: "ethers.js privateKey",     q: 'language:javascript "ethers" "privateKey"' },
    ],
  },
  {
    category: "RPC & Node Credentials",
    icon: FileCode,
    color: "text-blue-400",
    queries: [
      { label: "Infura Project ID",        q: 'filename:.env "INFURA_PROJECT_ID"' },
      { label: "Alchemy API key",          q: 'filename:.env "ALCHEMY_API_KEY"' },
      { label: "QuickNode token",          q: 'filename:.env "QUICKNODE_TOKEN"' },
      { label: "Moralis API key",          q: 'filename:.env "MORALIS_API_KEY"' },
      { label: "RPC URL + auth",           q: 'extension:env "RPC_URL" "SECRET"' },
    ],
  },
  {
    category: "NFT & Platform Keys",
    icon: ShieldAlert,
    color: "text-purple-400",
    queries: [
      { label: "OpenSea API key",          q: 'filename:.env "OPENSEA_API_KEY"' },
      { label: "Pinata IPFS key",          q: 'filename:.env "PINATA_API_KEY" "PINATA_SECRET"' },
      { label: "NFT Storage key",          q: 'filename:.env "NFT_STORAGE_API_KEY"' },
    ],
  },
  {
    category: "Keystore & Backup Files",
    icon: Key,
    color: "text-orange-400",
    queries: [
      { label: "Ethereum keystore",        q: 'filename:keystore.json "version" "crypto" "ciphertext"' },
      { label: "UTC-- keystore",           q: 'filename:UTC-- "ciphertext"' },
      { label: "Private Keys (raw)",       q: '"BEGIN RSA PRIVATE KEY"' },
      { label: "OpenSSH Private Key",      q: '"BEGIN OPENSSH PRIVATE KEY"' },
    ],
  },
];

function getSeverity(path: string, snippet: string): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const t = (path + " " + snippet).toLowerCase();
  if (
    t.includes("private_key") || t.includes("privatekey") || t.includes("mnemonic") ||
    t.includes("seed phrase") || t.includes("keystore") || t.includes("begin rsa") ||
    t.includes("begin openssh") || t.includes("id_rsa") || t.includes("ciphertext")
  ) return "CRITICAL";
  if (t.includes("secret") || t.includes("password") || t.includes("sk_live")) return "HIGH";
  if (t.includes("api_key") || t.includes("token") || t.includes("infura") || t.includes("alchemy")) return "MEDIUM";
  return "LOW";
}

const SEVERITY_CONFIG = {
  CRITICAL: { label: "CRITICAL", className: "bg-red-500/10 text-red-400 border-red-500/30" },
  HIGH:     { label: "HIGH",     className: "bg-orange-500/10 text-orange-400 border-orange-500/30" },
  MEDIUM:   { label: "MEDIUM",   className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30" },
  LOW:      { label: "LOW",      className: "bg-blue-500/10 text-blue-400 border-blue-500/30" },
};

function saveToHistory(query: string, count: number) {
  try {
    const raw = localStorage.getItem("gh_dork_history");
    const history: { query: string; count: number; ts: number }[] = raw ? JSON.parse(raw) : [];
    history.unshift({ query, count, ts: Date.now() });
    localStorage.setItem("gh_dork_history", JSON.stringify(history.slice(0, 50)));
  } catch {}
}

interface GitHubItem {
  name: string;
  path: string;
  html_url: string;
  severity?: string;
  snippet?: string;
  repository: {
    full_name: string;
    html_url: string;
    stargazers_count: number;
    updated_at: string;
  };
  text_matches?: Array<{ fragment: string }>;
}

interface SearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubItem[];
  error?: string;
}

interface ConfigResult {
  tokensConfigured: number;
  telegramConfigured: boolean;
}

async function searchGitHub(query: string, page: number): Promise<SearchResult> {
  const url = `/api/github/search?q=${encodeURIComponent(query)}&per_page=30&page=${page}`;
  const res = await fetch(url);
  const data = await res.json() as SearchResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Server error: ${res.status}`);
  return data;
}

export function Home() {
  const { toast } = useToast();
  const [query, setQuery] = useState<string>(() => {
    const r = sessionStorage.getItem("gh_dork_rerun");
    if (r) { sessionStorage.removeItem("gh_dork_rerun"); return r; }
    return "";
  });
  const [scope, setScope] = useState("");
  const [activeQuery, setActiveQuery] = useState<string>(() => {
    const r = sessionStorage.getItem("gh_dork_rerun_active");
    if (r) { sessionStorage.removeItem("gh_dork_rerun_active"); return r; }
    return "";
  });
  const [page, setPage] = useState(1);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const finalQuery = activeQuery
    ? scope.trim() ? `${activeQuery} user:${scope.trim()}` : activeQuery
    : "";

  // Backend config status
  const { data: config } = useQuery<ConfigResult>({
    queryKey: ["github-config"],
    queryFn: async () => {
      const res = await fetch("/api/github/config");
      return res.json() as Promise<ConfigResult>;
    },
    refetchInterval: 30000,
  });

  // Search results
  const { data, isLoading, error, isFetching } = useQuery<SearchResult, Error>({
    queryKey: ["github-search", finalQuery, page],
    queryFn: () => searchGitHub(finalQuery, page),
    enabled: !!finalQuery,
  });

  useEffect(() => {
    if (data && finalQuery) saveToHistory(finalQuery, data.total_count);
  }, [data, finalQuery]);

  const handleSearch = () => {
    if (!query.trim()) return;
    setActiveQuery(query.trim());
    setPage(1);
  };

  const handleDorkClick = (q: string) => {
    setQuery(q);
    setActiveQuery(q);
    setPage(1);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ description: "Disalin ke clipboard." });
  };

  const handleNotifyTest = async () => {
    const res = await fetch("/api/github/notify-test", { method: "POST" });
    const d = await res.json() as { ok?: boolean; message?: string; error?: string };
    if (d.ok) toast({ description: "Notifikasi test dikirim ke Telegram!" });
    else toast({ description: d.error ?? "Gagal kirim notifikasi.", variant: "destructive" });
  };

  const totalPages = data ? Math.ceil(Math.min(data.total_count, 1000) / 30) : 0;
  const tokensOk = (config?.tokensConfigured ?? 0) > 0;
  const telegramOk = config?.telegramConfigured ?? false;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 flex gap-5">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 hidden lg:block">
        <div className="sticky top-20 space-y-0.5">
          {/* Config status */}
          <div className="bg-card border border-border rounded p-3 mb-3 space-y-1.5">
            <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest mb-1">
              Status
            </div>
            <div className="flex items-center gap-2">
              {tokensOk
                ? <CheckCircle className="w-3 h-3 text-primary" />
                : <AlertTriangle className="w-3 h-3 text-yellow-400" />}
              <span className="text-xs font-mono text-muted-foreground">
                {tokensOk
                  ? `${config?.tokensConfigured} token aktif`
                  : "Token belum diset"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {telegramOk
                  ? <CheckCircle className="w-3 h-3 text-primary" />
                  : <AlertTriangle className="w-3 h-3 text-yellow-400" />}
                <span className="text-xs font-mono text-muted-foreground">
                  {telegramOk ? "Telegram aktif" : "Telegram belum diset"}
                </span>
              </div>
              {telegramOk && (
                <button
                  data-testid="button-test-telegram"
                  onClick={handleNotifyTest}
                  className="text-muted-foreground hover:text-primary transition-colors"
                  title="Test notifikasi Telegram"
                >
                  <Send className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest mb-2 px-1">
            Crypto Dork Library
          </div>
          {DORK_LIBRARY.map((cat) => {
            const Icon = cat.icon;
            const isOpen = activeCategory === cat.category;
            return (
              <div key={cat.category}>
                <button
                  data-testid={`category-${cat.category.replace(/\s+/g, "-")}`}
                  onClick={() => setActiveCategory(isOpen ? null : cat.category)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-left"
                >
                  <Icon className={cn("w-3 h-3 shrink-0", cat.color)} />
                  <span className="truncate">{cat.category}</span>
                </button>
                {isOpen && (
                  <div className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-2 pb-1">
                    {cat.queries.map((dork) => (
                      <button
                        key={dork.q}
                        data-testid={`dork-${dork.label.replace(/\s+/g, "-")}`}
                        onClick={() => handleDorkClick(dork.q)}
                        className="w-full text-left text-xs font-mono text-muted-foreground hover:text-primary py-1 px-1 rounded hover:bg-primary/5 transition-colors truncate"
                        title={dork.q}
                      >
                        {dork.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* No token warning */}
        {config && !tokensOk && (
          <div
            data-testid="no-token-warning"
            className="bg-yellow-400/5 border border-yellow-400/20 rounded p-3 flex items-start gap-2"
          >
            <ServerCrash className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-mono text-yellow-400 font-medium">Token GitHub belum dikonfigurasi</div>
              <div className="text-xs font-mono text-muted-foreground mt-1">
                Set <code className="text-primary">GITHUB_TOKEN</code> atau{" "}
                <code className="text-primary">TOKEN_1</code>,{" "}
                <code className="text-primary">TOKEN_2</code> di Replit Secrets.
              </div>
            </div>
          </div>
        )}

        {/* Search section */}
        <div className="bg-card border border-border rounded p-3 space-y-2">
          <div className="flex gap-2">
            <Input
              data-testid="input-query"
              placeholder='filename:.env "PRIVATE_KEY"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="font-mono text-sm bg-background border-border"
            />
            <Button
              data-testid="button-search"
              onClick={handleSearch}
              disabled={!query.trim() || isLoading || !tokensOk}
              className="gap-1.5 font-mono text-xs shrink-0"
            >
              <Search className="w-3.5 h-3.5" />
              Search
            </Button>
          </div>
          <Input
            data-testid="input-scope"
            placeholder="Scope: username atau org GitHub (opsional)"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="font-mono text-xs bg-background border-border"
          />

          {/* Mobile dork pills */}
          <div className="lg:hidden flex flex-wrap gap-1 pt-1">
            {DORK_LIBRARY.flatMap((cat) =>
              cat.queries.slice(0, 2).map((dork) => (
                <button
                  key={dork.q}
                  data-testid={`mobile-dork-${dork.label.replace(/\s+/g, "-")}`}
                  onClick={() => handleDorkClick(dork.q)}
                  className="px-2 py-0.5 rounded text-xs font-mono bg-accent text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors border border-border"
                >
                  {dork.label}
                </button>
              ))
            )}
          </div>

          {/* Query preview */}
          {finalQuery && (
            <div className="flex items-center gap-2 px-2 py-1.5 bg-background rounded border border-border">
              <Zap className="w-3 h-3 text-primary shrink-0" />
              <span className="font-mono text-xs text-muted-foreground truncate flex-1">{finalQuery}</span>
              <button
                data-testid="button-copy-query"
                onClick={() => handleCopy(finalQuery)}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Loading */}
        {(isLoading || isFetching) && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-card border border-border rounded p-3 space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-16 w-full" />
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {error && !isFetching && (
          <div data-testid="error-message" className="bg-destructive/10 border border-destructive/30 rounded p-4 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-mono text-destructive font-medium">Pencarian Gagal</div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">{error.message}</div>
            </div>
          </div>
        )}

        {/* Results */}
        {data && !isLoading && (
          <>
            <div data-testid="results-summary" className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground">
                <span className="text-primary font-bold">{data.total_count.toLocaleString()}</span>{" "}
                hasil ditemukan
                {data.total_count > 1000 && <span className="ml-1">(maks. 1000 dapat diakses)</span>}
              </span>
              <span className="text-muted-foreground hidden sm:inline">
                Halaman {page} / {totalPages || 1}
              </span>
            </div>

            {data.total_count > 0 && telegramOk && (
              <div data-testid="telegram-active-notice" className="flex items-center gap-2 text-xs font-mono text-primary/70 bg-primary/5 border border-primary/10 rounded px-2 py-1.5">
                <Send className="w-3 h-3 shrink-0" />
                Notifikasi CRITICAL/HIGH otomatis dikirim ke Telegram
              </div>
            )}

            {data.total_count > 0 && (
              <div data-testid="rate-limit-info" className="flex items-center gap-2 text-xs font-mono text-yellow-400/70 bg-yellow-400/5 border border-yellow-400/10 rounded px-2 py-1.5">
                <Info className="w-3 h-3 shrink-0" />
                GitHub membatasi pencarian kode 30 hasil per halaman.
              </div>
            )}

            {data.items.length === 0 && (
              <div data-testid="empty-state" className="bg-card border border-border rounded p-12 text-center">
                <Search className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                <div className="text-sm font-mono text-muted-foreground">Tidak ada hasil ditemukan</div>
                <div className="text-xs text-muted-foreground mt-1">Coba query berbeda atau hapus filter scope</div>
              </div>
            )}

            <div className="space-y-2">
              {data.items.map((item: GitHubItem, idx: number) => {
                const snippet = item.snippet ?? item.text_matches?.[0]?.fragment ?? "";
                const sev = (item.severity as keyof typeof SEVERITY_CONFIG) ?? getSeverity(item.path, snippet);
                const sevConfig = SEVERITY_CONFIG[sev] ?? SEVERITY_CONFIG.LOW;
                const updatedAt = new Date(item.repository.updated_at).toLocaleDateString("id-ID");

                return (
                  <div
                    key={`${item.html_url}-${idx}`}
                    data-testid={`result-card-${idx}`}
                    className="bg-card border border-border rounded p-3 space-y-2 hover:border-primary/30 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <a
                            href={item.repository.html_url}
                            target="_blank" rel="noopener noreferrer"
                            data-testid={`link-repo-${idx}`}
                            className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
                          >
                            {item.repository.full_name}
                          </a>
                          <span className="text-muted-foreground/40 text-xs">/</span>
                          <a
                            href={item.html_url}
                            target="_blank" rel="noopener noreferrer"
                            data-testid={`link-file-${idx}`}
                            className="text-xs font-mono text-primary hover:underline flex items-center gap-1 truncate"
                          >
                            {item.path}
                            <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                          </a>
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                            <Star className="w-2.5 h-2.5" />
                            {item.repository.stargazers_count.toLocaleString()}
                          </span>
                          <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                            <Clock className="w-2.5 h-2.5" />
                            {updatedAt}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge
                          data-testid={`severity-${idx}`}
                          className={cn("text-xs font-mono border px-1.5 py-0 h-5", sevConfig.className)}
                        >
                          {sevConfig.label}
                        </Badge>
                        <button
                          data-testid={`button-copy-url-${idx}`}
                          onClick={() => handleCopy(item.html_url)}
                          className="text-muted-foreground hover:text-foreground transition-colors p-1"
                          title="Salin URL"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {snippet && (
                      <pre className="bg-background rounded text-xs font-mono text-muted-foreground p-2 overflow-x-auto whitespace-pre-wrap break-all border border-border/50 leading-relaxed max-h-32 overflow-y-auto">
                        {snippet}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div data-testid="pagination" className="flex items-center justify-center gap-3 pt-2">
                <Button
                  data-testid="button-prev-page"
                  variant="outline" size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1 || isFetching}
                  className="font-mono text-xs gap-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Prev
                </Button>
                <span className="text-xs font-mono text-muted-foreground">{page} / {totalPages}</span>
                <Button
                  data-testid="button-next-page"
                  variant="outline" size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages || isFetching}
                  className="font-mono text-xs gap-1"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </>
        )}

        {/* Initial state */}
        {!finalQuery && !isLoading && (
          <div data-testid="initial-state" className="bg-card border border-border rounded p-12 text-center">
            <Wallet className="w-10 h-10 text-muted-foreground/30 mx-auto mb-4" />
            <div className="text-sm font-mono text-muted-foreground">Pilih dork atau ketik query manual</div>
            <div className="text-xs text-muted-foreground mt-2 max-w-sm mx-auto leading-relaxed">
              Cari wallet key, seed phrase, exchange API key, dan kredensial DeFi yang tidak sengaja di-commit ke repositori GitHub publik.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
