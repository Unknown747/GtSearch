import { Link, useLocation } from "wouter";
import { SiGithub } from "react-icons/si";
import { History, Search, Shield, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-12 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              <span className="font-mono text-sm font-bold text-foreground tracking-wider">
                GH<span className="text-primary">DORK</span>
              </span>
            </div>
            <span className="text-muted-foreground text-xs font-mono hidden sm:inline">
              // GitHub sensitive data search
            </span>
          </div>

          <nav className="flex items-center gap-1">
            <Link
              href="/"
              data-testid="nav-search"
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono transition-colors",
                location === "/"
                  ? "bg-primary/10 text-primary border border-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <Search className="w-3 h-3" />
              Search
            </Link>
            <Link
              href="/history"
              data-testid="nav-history"
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono transition-colors",
                location === "/history"
                  ? "bg-primary/10 text-primary border border-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <History className="w-3 h-3" />
              History
            </Link>
            <Link
              href="/cli"
              data-testid="nav-cli"
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono transition-colors",
                location === "/cli"
                  ? "bg-primary/10 text-primary border border-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <Terminal className="w-3 h-3" />
              CLI
            </Link>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="nav-github"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ml-2 border-l border-border"
            >
              <SiGithub className="w-3.5 h-3.5" />
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border py-3 px-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <span className="text-muted-foreground text-xs font-mono">
            For security research &amp; authorized auditing only
          </span>
          <span className="text-muted-foreground text-xs font-mono">
            GitHub Search API
          </span>
        </div>
      </footer>
    </div>
  );
}
