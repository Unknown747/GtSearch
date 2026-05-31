import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  Eye,
  EyeOff,
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
      { label: 'mnemonic seed phrase', q: '"mnemonic" "seed phrase" language:javascript' },
      { label: 'private key hex .env', q: 'filename:.env "PRIVATE_KEY"' },
      { label: 'wallet private key js', q: '"privateKey" "0x" filename:*.js' },
      { label: 'BIP39 mnemonic', q: '"bip39" "mnemonic" "entropy"' },
      { label: 'seed words 12/24', q: '"word1" "word2" "word3" filename:*.json' },
      { label: 'MNEMONIC .env', q: 'filename:.env "MNEMONIC"' },
      { label: 'wallet.json keystore', q: 'filename:wallet.json "crypto" "ciphertext"' },
    ],
  },
  {
    category: "Exchange API Keys",
    icon: Key,
    color: "text-red-400",
    queries: [
      { label: 'Binance API key', q: '"BINANCE_API_KEY" OR "BINANCE_SECRET"' },
      { label: 'Coinbase API key', q: '"COINBASE_API_KEY" OR "COINBASE_API_SECRET"' },
      { label: 'Kraken API key', q: '"KRAKEN_API_KEY" OR "KRAKEN_PRIVATE_KEY"' },
      { label: 'OKX/OKEx API key', q: '"OKX_API_KEY" OR "OKEX_SECRET_KEY"' },
      { label: 'KuCoin credentials', q: '"KUCOIN_API_KEY" "KUCOIN_API_SECRET"' },
      { label: 'Bybit API key', q: '"BYBIT_API_KEY" OR "BYBIT_SECRET"' },
      { label: 'Bitfinex key', q: '"BITFINEX_KEY" OR "BITFINEX_SECRET"' },
    ],
  },
  {
    category: "Smart Contract & DeFi",
    icon: Layers,
    color: "text-cyan-400",
    queries: [
      { label: 'Hardhat private key', q: 'filename:hardhat.config.js "privateKey"' },
      { label: 'Truffle private key', q: 'filename:truffle-config.js "privateKey"' },
      { label: 'Foundry private key', q: 'filename:.env "PRIVATE_KEY" "foundry"' },
      { label: 'Infura/Alchemy key', q: '"INFURA_PROJECT_ID" OR "ALCHEMY_API_KEY"' },
      { label: 'Metamask key config', q: '"METAMASK_PRIVATE_KEY" filename:.env' },
      { label: 'deployer key config', q: '"DEPLOYER_PRIVATE_KEY" filename:.env' },
      { label: 'Web3 provider key', q: '"WEB3_PROVIDER" "private" filename:.env' },
    ],
  },
  {
    category: "Node & RPC Credentials",
    icon: FileCode,
    color: "text-blue-400",
    queries: [
      { label: 'Ethereum node JWT', q: '"JWT_SECRET" "ethereum" OR "geth" OR "besu"' },
      { label: 'RPC endpoint auth', q: '"RPC_URL" "username" "password" filename:.env' },
      { label: 'Infura endpoint key', q: '"infura.io/v3/" path:*.env OR path:*.json' },
      { label: 'QuickNode token', q: '"quiknode.pro" "token" filename:*.env' },
      { label: 'Ankr API key', q: '"ANKR_API_KEY" filename:.env' },
    ],
  },
  {
    category: "NFT & Platform Keys",
    icon: ShieldAlert,
    color: "text-purple-400",
    queries: [
      { label: 'OpenSea API key', q: '"OPENSEA_API_KEY" filename:.env' },
      { label: 'Moralis API key', q: '"MORALIS_API_KEY" filename:.env' },
      { label: 'Pinata IPFS key', q: '"PINATA_API_KEY" "PINATA_SECRET" filename:.env' },
      { label: 'NFT storage key', q: '"NFT_STORAGE_API_KEY" filename:.env' },
      { label: 'Alchemy NFT key', q: '"ALCHEMY_API_KEY" "nft" filename:.env' },
    ],
  },
  {
    category: "Keystore & Backup Files",
    icon: Key,
    color: "text-orange-400",
    queries: [
      { label: 'Ethereum keystore file', q: 'filename:keystore "version" "crypto" "ciphertext"' },
      { label: 'UTC keystore JSON', q: 'filename:UTC-- "crypto" "kdfparams"' },
      { label: '.keystore files', q: 'extension:keystore "privateKey"' },
      { label: 'backup wallet config', q: 'filename:wallet_backup "seed" OR "private"' },
    ],
  },
];

function getSeverity(snippet: string, path: string): "critical" | "high" | "medium" | "info" {
  const text = (snippet + " " + path).toLowerCase();
  if (
    text.includes("private_key") ||
    text.includes("privatekey") ||
    text.includes("mnemonic") ||
    text.includes("seed phrase") ||
    text.includes("keystore") ||
    text.includes("ciphertext") ||
    text.includes("id_rsa")
  )
    return "critical";
  if (
    text.includes("secret") ||
    text.includes("api_secret") ||
    text.includes("password") ||
    text.includes("jwt_secret")
  )
    return "high";
  if (
    text.includes("api_key") ||
    text.includes("token") ||
    text.includes("infura") ||
    text.includes("alchemy") ||
    text.includes("rpc_url")
  )
    return "medium";
  return "info";
}

const SEVERITY_CONFIG = {
  critical: { label: "CRITICAL", className: "bg-red-500/10 text-red-400 border-red-500/30" },
  high: { label: "HIGH", className: "bg-orange-500/10 text-orange-400 border-orange-500/30" },
  medium: { label: "MEDIUM", className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30" },
  info: { label: "INFO", className: "bg-blue-500/10 text-blue-400 border-blue-500/30" },
};

function saveToHistory(query: string, resultCount: number) {
  try {
    const raw = localStorage.getItem("gh_dork_history");
    const history: { query: string; count: number; ts: number }[] = raw ? JSON.parse(raw) : [];
    history.unshift({ query, count: resultCount, ts: Date.now() });
    localStorage.setItem("gh_dork_history", JSON.stringify(history.slice(0, 50)));
  } catch {}
}

interface GitHubItem {
  name: string;
  path: string;
  html_url: string;
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
}

async function searchGitHub(
  query: string,
  token: string | null,
  page: number
): Promise<SearchResult> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.text-match+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=30&page=${page}`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Invalid or expired token. Check your GitHub token.");
    if (res.status === 403) {
      const reset = res.headers.get("x-ratelimit-reset");
      const resetTime = reset ? new Date(parseInt(reset) * 1000).toLocaleTimeString() : "soon";
      throw new Error(`Rate limit exceeded. Resets at ${resetTime}. Add a GitHub token for higher limits.`);
    }
    if (res.status === 422)
      throw new Error("Query validation failed. Try simplifying your search query.");
    throw new Error((body as { message?: string }).message || `GitHub API error: ${res.status}`);
  }

  return res.json() as Promise<SearchResult>;
}

export function Home() {
  const { toast } = useToast();
  const [token, setToken] = useState<string>(() => localStorage.getItem("gh_dork_token") || "");
  const [showToken, setShowToken] = useState(false);
  const [query, setQuery] = useState<string>(() => {
    const rerun = sessionStorage.getItem("gh_dork_rerun");
    if (rerun) {
      sessionStorage.removeItem("gh_dork_rerun");
      return rerun;
    }
    return "";
  });
  const [scope, setScope] = useState("");
  const [activeQuery, setActiveQuery] = useState<string>(() => {
    const rerun = sessionStorage.getItem("gh_dork_rerun_active");
    if (rerun) {
      sessionStorage.removeItem("gh_dork_rerun_active");
      return rerun;
    }
    return "";
  });
  const [page, setPage] = useState(1);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const finalQuery = activeQuery
    ? scope.trim()
      ? `${activeQuery} user:${scope.trim()}`
      : activeQuery
    : "";

  const { data, isLoading, error, isFetching } = useQuery<SearchResult, Error>({
    queryKey: ["github-search", finalQuery, page],
    queryFn: () => searchGitHub(finalQuery, token || null, page),
    enabled: !!finalQuery,
  });

  useEffect(() => {
    if (data && finalQuery) {
      saveToHistory(finalQuery, data.total_count);
    }
  }, [data, finalQuery]);

  const handleTokenSave = () => {
    localStorage.setItem("gh_dork_token", token);
    toast({ description: "Token saved to local storage." });
  };

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
    toast({ description: "Copied to clipboard." });
  };

  const totalPages = data ? Math.ceil(Math.min(data.total_count, 1000) / 30) : 0;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 flex gap-5">
      {/* Sidebar: Dork Library */}
      <aside className="w-64 shrink-0 hidden lg:block">
        <div className="sticky top-20 space-y-0.5">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-widest mb-3 px-1">
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

      {/* Main content */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Token section */}
        <div className="bg-card border border-border rounded p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-muted-foreground">GitHub Token</span>
              {token ? (
                <span className="flex items-center gap-1 text-xs font-mono text-primary">
                  <CheckCircle className="w-3 h-3" /> Set
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs font-mono text-yellow-400">
                  <AlertTriangle className="w-3 h-3" /> Not set — limited to 10 req/min
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
              Stored locally only
            </span>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                data-testid="input-token"
                type={showToken ? "text" : "password"}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleTokenSave()}
                className="font-mono text-xs pr-8 bg-background border-border"
              />
              <button
                data-testid="toggle-token-visibility"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <Button
              data-testid="button-save-token"
              onClick={handleTokenSave}
              size="sm"
              className="font-mono text-xs"
            >
              Save
            </Button>
          </div>
        </div>

        {/* Search section */}
        <div className="bg-card border border-border rounded p-3 space-y-3">
          <div className="space-y-2">
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
                disabled={!query.trim() || isLoading}
                className="gap-1.5 font-mono text-xs shrink-0"
              >
                <Search className="w-3.5 h-3.5" />
                Search
              </Button>
            </div>
            <Input
              data-testid="input-scope"
              placeholder="Scope: GitHub username or org (optional)"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="font-mono text-xs bg-background border-border"
            />
          </div>

          {/* Mobile dork pills */}
          <div className="lg:hidden">
            <div className="text-xs font-mono text-muted-foreground mb-2">Quick Dorks:</div>
            <div className="flex flex-wrap gap-1">
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
          </div>

          {/* Final query preview */}
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

        {/* Loading state */}
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

        {/* Error state */}
        {error && !isFetching && (
          <div
            data-testid="error-message"
            className="bg-destructive/10 border border-destructive/30 rounded p-4 flex items-start gap-3"
          >
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-mono text-destructive font-medium">Search Failed</div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">{error.message}</div>
            </div>
          </div>
        )}

        {/* Results */}
        {data && !isLoading && (
          <>
            <div
              data-testid="results-summary"
              className="flex items-center justify-between text-xs font-mono"
            >
              <span className="text-muted-foreground">
                <span className="text-primary font-bold">{data.total_count.toLocaleString()}</span>{" "}
                results found
                {data.total_count > 1000 && (
                  <span className="text-muted-foreground ml-1">(first 1000 accessible)</span>
                )}
              </span>
              <span className="text-muted-foreground hidden sm:inline">
                Page {page} / {totalPages || 1}
              </span>
            </div>

            {data.total_count > 0 && (
              <div
                data-testid="rate-limit-warning"
                className="flex items-center gap-2 text-xs font-mono text-yellow-400/70 bg-yellow-400/5 border border-yellow-400/10 rounded px-2 py-1.5"
              >
                <Info className="w-3 h-3 shrink-0" />
                GitHub limits code search to 30 results per page. Use pagination to see more.
              </div>
            )}

            {data.items.length === 0 && (
              <div
                data-testid="empty-state"
                className="bg-card border border-border rounded p-12 text-center"
              >
                <Search className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                <div className="text-sm font-mono text-muted-foreground">No results found</div>
                <div className="text-xs text-muted-foreground mt-1">
                  Try a different query or remove scope filters
                </div>
              </div>
            )}

            <div className="space-y-2">
              {data.items.map((item: GitHubItem, idx: number) => {
                const snippet = item.text_matches?.[0]?.fragment || item.path;
                const severity = getSeverity(snippet, item.path);
                const sev = SEVERITY_CONFIG[severity];
                const updatedAt = new Date(item.repository.updated_at).toLocaleDateString();

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
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid={`link-repo-${idx}`}
                            className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
                          >
                            {item.repository.full_name}
                          </a>
                          <span className="text-muted-foreground/40 text-xs">/</span>
                          <a
                            href={item.html_url}
                            target="_blank"
                            rel="noopener noreferrer"
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
                          className={cn(
                            "text-xs font-mono border px-1.5 py-0 h-5",
                            sev.className
                          )}
                        >
                          {sev.label}
                        </Badge>
                        <button
                          data-testid={`button-copy-url-${idx}`}
                          onClick={() => handleCopy(item.html_url)}
                          className="text-muted-foreground hover:text-foreground transition-colors p-1"
                          title="Copy URL"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {item.text_matches?.[0]?.fragment && (
                      <pre className="bg-background rounded text-xs font-mono text-muted-foreground p-2 overflow-x-auto whitespace-pre-wrap break-all border border-border/50 leading-relaxed max-h-32 overflow-y-auto">
                        {item.text_matches[0].fragment}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div
                data-testid="pagination"
                className="flex items-center justify-center gap-3 pt-2"
              >
                <Button
                  data-testid="button-prev-page"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1 || isFetching}
                  className="font-mono text-xs gap-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Prev
                </Button>
                <span className="text-xs font-mono text-muted-foreground">
                  {page} / {totalPages}
                </span>
                <Button
                  data-testid="button-next-page"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages || isFetching}
                  className="font-mono text-xs gap-1"
                >
                  Next
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </>
        )}

        {/* Initial empty state */}
        {!finalQuery && !isLoading && (
          <div
            data-testid="initial-state"
            className="bg-card border border-border rounded p-12 text-center"
          >
            <Wallet className="w-10 h-10 text-muted-foreground/30 mx-auto mb-4" />
            <div className="text-sm font-mono text-muted-foreground">
              Select a dork or enter a custom query
            </div>
            <div className="text-xs text-muted-foreground mt-2 max-w-sm mx-auto leading-relaxed">
              Search GitHub for accidentally committed crypto wallet keys, exchange credentials,
              seed phrases, and DeFi secrets in public repositories.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
