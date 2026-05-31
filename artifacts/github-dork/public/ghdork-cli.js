#!/usr/bin/env node
/**
 * GH Dork CLI — Blockchain & Crypto Sensitive Data Scanner
 * =========================================================
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node index.js [options]
 *   TOKEN_ARRAY=ghp_a,ghp_b,ghp_c node index.js --all
 *
 * Options:
 *   --all                    Run all 69 dork queries
 *   --category <name>        Run a specific category (use --list-categories)
 *   --query <q>              Run a single custom query
 *   --scope <user|org>       Scope searches to a GitHub user or org
 *   --validate               Enable credential format validation
 *   --format <json|csv|txt|md>  Output format (default: json)
 *   --output <file>          Output file path (default: results-<ts>.<ext>)
 *   --delay <ms>             Delay between requests in ms (default: 1200)
 *   --max-results <n>        Max results per query (default: 30, max: 100)
 *   --list-categories        List all available dork categories
 *   --verbose                Verbose logging
 *   --help                   Show this help
 *
 * Node.js 18+ required (native fetch). No external dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ─── ANSI Colors ─────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
};

const log = {
  info: (msg) => console.log(`${C.cyan}[INFO]${C.reset} ${msg}`),
  ok: (msg) => console.log(`${C.green}[OK]${C.reset}  ${msg}`),
  warn: (msg) => console.log(`${C.yellow}[WARN]${C.reset} ${msg}`),
  error: (msg) => console.error(`${C.red}[ERR]${C.reset}  ${msg}`),
  hit: (msg) => console.log(`${C.bgRed}${C.white}[HIT]${C.reset} ${msg}`),
  verbose: (msg, enabled) => enabled && console.log(`${C.dim}[DBG]  ${msg}${C.reset}`),
  section: (msg) => console.log(`\n${C.bold}${C.blue}── ${msg} ──${C.reset}`),
};

// ─── CLASS 1: GitHubClient ───────────────────────────────────────────────────
class GitHubClient {
  constructor(tokens = [], verbose = false) {
    if (!tokens.length) throw new Error("No GitHub token(s) provided. Set GITHUB_TOKEN or TOKEN_ARRAY env vars.");
    this.tokens = [...tokens];
    this.currentIndex = 0;
    this.verbose = verbose;
    this.requestCount = 0;
    this.BASE = "https://api.github.com";
  }

  get currentToken() {
    return this.tokens[this.currentIndex];
  }

  _rotateToken() {
    if (this.tokens.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
      log.warn(`Rotated to token #${this.currentIndex + 1}/${this.tokens.length}`);
    }
  }

  async _sleep(ms) {
    log.warn(`Sleeping ${(ms / 1000).toFixed(1)}s …`);
    await sleep(ms);
  }

  async _handleRateLimit(headers) {
    const remaining = parseInt(headers.get("x-ratelimit-remaining") ?? "999", 10);
    const reset = parseInt(headers.get("x-ratelimit-reset") ?? "0", 10);
    const resource = headers.get("x-ratelimit-resource") ?? "?";

    log.verbose(`Rate [${resource}] remaining=${remaining} reset=${new Date(reset * 1000).toLocaleTimeString()}`, this.verbose);

    if (remaining < 5 && reset > 0) {
      const now = Math.floor(Date.now() / 1000);
      const wait = Math.max(0, (reset - now + 5)) * 1000;
      log.warn(`Rate limit low (${remaining} left) on token #${this.currentIndex + 1}. Reset in ${(wait / 1000).toFixed(0)}s`);
      if (this.tokens.length > 1) {
        this._rotateToken();
      } else {
        await this._sleep(wait);
      }
    }
  }

  async _request(url, retries = 3) {
    this.requestCount++;
    const headers = {
      Authorization: `token ${this.currentToken}`,
      Accept: "application/vnd.github.text-match+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "GH-Dork-CLI/2.0",
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        log.verbose(`GET ${url}`, this.verbose);
        const res = await fetch(url, { headers });
        await this._handleRateLimit(res.headers);

        if (res.status === 200) return await res.json();

        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          if (body.message?.includes("secondary rate")) {
            await this._sleep(60000);
            continue;
          }
          this._rotateToken();
          continue;
        }

        if (res.status === 401) {
          log.error(`Token #${this.currentIndex + 1} is invalid or expired.`);
          this._rotateToken();
          if (attempt === retries) throw new Error("All tokens invalid.");
          continue;
        }

        if (res.status === 422) {
          const body = await res.json().catch(() => ({}));
          return { total_count: 0, items: [], _error: body.message ?? "422 Unprocessable" };
        }

        if (res.status === 429 || res.status >= 500) {
          await this._sleep(Math.pow(2, attempt) * 5000);
          continue;
        }

        const body = await res.json().catch(() => ({}));
        return { total_count: 0, items: [], _error: `HTTP ${res.status}: ${body.message ?? ""}` };

      } catch (err) {
        if (attempt === retries) throw err;
        await this._sleep(2000 * attempt);
      }
    }
    return { total_count: 0, items: [] };
  }

  async searchCode(query, page = 1, perPage = 30) {
    const q = encodeURIComponent(query);
    const url = `${this.BASE}/search/code?q=${q}&per_page=${Math.min(perPage, 100)}&page=${page}`;
    return this._request(url);
  }

  async getRateLimit() {
    return this._request(`${this.BASE}/rate_limit`);
  }

  getStats() {
    return { totalRequests: this.requestCount, tokenCount: this.tokens.length };
  }
}

// ─── CLASS 2: DorkManager ────────────────────────────────────────────────────
class DorkManager {
  constructor() {
    this._dorks = {
      "Private Keys": [
        { id: "PK01", label: "Ethereum PRIVATE_KEY .env",       q: 'filename:.env PRIVATE_KEY 0x' },
        { id: "PK02", label: "Ethereum raw hex JSON",            q: 'extension:json privateKey' },
        { id: "PK03", label: "Bitcoin WIF (txt)",                q: 'extension:txt "5HueCGU8rMjxECyDialwujzdhLGDGe"' },
        { id: "PK04", label: "Solana base58 JSON",               q: 'extension:json "secretKey" solana' },
        { id: "PK05", label: "PEM Private Key",                  q: '"BEGIN PRIVATE KEY" extension:pem' },
        { id: "PK06", label: "OpenSSH Private Key",              q: '"BEGIN OPENSSH PRIVATE KEY"' },
        { id: "PK07", label: "*.key PRIVATE KEY path",           q: 'path:*.key "PRIVATE KEY"' },
        { id: "PK08", label: "PKCS8 Encrypted",                  q: '"BEGIN ENCRYPTED PRIVATE KEY"' },
        { id: "PK09", label: "id_rsa file",                      q: 'filename:id_rsa NOT "BEGIN OPENSSH"' },
        { id: "PK10", label: "Apple .p8 private",                q: 'extension:p8 private' },
        { id: "PK11", label: ".pk private file",                  q: 'extension:pk "private"' },
        { id: "PK12", label: "Ethereum keystore.json",           q: 'filename:keystore.json "crypto" "address"' },
        { id: "PK13", label: "UTC-- keystore",                   q: 'filename:UTC-- "ciphertext"' },
        { id: "PK14", label: "Base64 key in .env",               q: 'extension:env "PRIVATE" "KEY"' },
        { id: "PK15", label: "wallet.dat private",               q: 'filename:wallet.dat "private"' },
      ],

      "Seed Phrases & Mnemonics": [
        { id: "SP01", label: "BIP39 12-word mnemonic",           q: 'mnemonic "word" "bip39"' },
        { id: "SP02", label: "BIP39 24-word seed phrase",        q: '"seed phrase" "24" mnemonic' },
        { id: "SP03", label: "MetaMask seed file",               q: 'filename:.metamask "seed"' },
        { id: "SP04", label: "Trust Wallet mnemonic JSON",       q: '"trustwallet" "mnemonic" extension:json' },
        { id: "SP05", label: "Ledger recovery phrase",           q: '"ledger" "recovery phrase"' },
        { id: "SP06", label: "Trezor seed txt",                  q: '"trezor" "seed" extension:txt' },
        { id: "SP07", label: "Phantom (Solana) mnemonic",        q: '"phantom" "mnemonic" extension:json' },
        { id: "SP08", label: "recovery.txt phrase",              q: 'filename:recovery.txt "phrase"' },
        { id: "SP09", label: "seed backup text files",           q: 'filename:seed_backup.txt' },
        { id: "SP10", label: "mnemonic.json",                    q: 'filename:mnemonic.json' },
      ],

      "Exchange API Keys": [
        { id: "EX01", label: "Binance API key .env",             q: 'filename:.env "BINANCE_API_KEY"' },
        { id: "EX02", label: "Coinbase API key .env",            q: 'filename:.env "COINBASE_API_KEY"' },
        { id: "EX03", label: "Kraken API key+secret",            q: 'filename:.env "KRAKEN_API_KEY"' },
        { id: "EX04", label: "KuCoin key+secret",                q: 'filename:.env "KUCOIN_KEY"' },
        { id: "EX05", label: "Bybit API key",                    q: 'filename:.env "BYBIT_API_KEY"' },
        { id: "EX06", label: "OKX API key",                      q: 'filename:.env "OKX_API_KEY"' },
        { id: "EX07", label: "Gate.io API key",                  q: 'filename:.env "GATE_API_KEY"' },
        { id: "EX08", label: "Crypto.com API key",               q: 'filename:.env "CRYPTO_COM_API_KEY"' },
        { id: "EX09", label: "Bitget API key",                   q: 'filename:.env "BITGET_API_KEY"' },
        { id: "EX10", label: "HTX (Huobi) API key",              q: 'filename:.env "HUOBI_API_KEY"' },
        { id: "EX11", label: "MEXC API key",                     q: 'filename:.env "MEXC_API_KEY"' },
        { id: "EX12", label: "Multi-exchange .env",              q: 'filename:.env "API_KEY" "SECRET" exchange' },
      ],

      "Wallet Configuration Files": [
        { id: "WC01", label: ".env wallet keys",                 q: 'filename:.env PRIVATE_KEY OR MNEMONIC' },
        { id: "WC02", label: "wallet.json private_key",         q: 'filename:wallet.json private_key' },
        { id: "WC03", label: "config.json ethereum key",        q: 'filename:config.json ethereum privateKey' },
        { id: "WC04", label: "secrets.json mnemonic",           q: 'filename:secrets.json "mnemonic"' },
        { id: "WC05", label: "app.config.js privateKey",        q: 'filename:app.config.js "privateKey"' },
        { id: "WC06", label: "settings.json seed",              q: 'filename:settings.json "seed"' },
        { id: "WC07", label: ".secrets file",                   q: 'filename:.secrets' },
        { id: "WC08", label: "credentials.json crypto",         q: 'filename:credentials.json crypto' },
      ],

      "Web3 Framework Files": [
        { id: "WF01", label: "Hardhat config PRIVATE_KEY",      q: 'filename:hardhat.config.js "PRIVATE_KEY"' },
        { id: "WF02", label: "Hardhat TS mnemonic",             q: 'filename:hardhat.config.ts "mnemonic"' },
        { id: "WF03", label: "Truffle config mnemonic/key",     q: 'filename:truffle-config.js "mnemonic"' },
        { id: "WF04", label: "Foundry private_key",             q: 'filename:foundry.toml "private_key"' },
        { id: "WF05", label: "Brownie config private_key",      q: 'filename:brownie-config.yaml "private_key"' },
        { id: "WF06", label: "Web3.py private_key",             q: 'language:python "web3" "private_key"' },
        { id: "WF07", label: "ethers.js privateKey",            q: 'language:javascript "ethers" "privateKey"' },
        { id: "WF08", label: "web3.js privateKey",              q: 'language:javascript "web3.eth" "privateKey"' },
      ],

      "RPC & Node Credentials": [
        { id: "RPC01", label: "Infura Project ID .env",         q: 'filename:.env "INFURA_PROJECT_ID"' },
        { id: "RPC02", label: "Alchemy API key .env",           q: 'filename:.env "ALCHEMY_API_KEY"' },
        { id: "RPC03", label: "QuickNode token .env",           q: 'filename:.env "QUICKNODE_TOKEN"' },
        { id: "RPC04", label: "Moralis API key .env",           q: 'filename:.env "MORALIS_API_KEY"' },
        { id: "RPC05", label: "Chainstack API key .env",        q: 'filename:.env "CHAINSTACK_API_KEY"' },
        { id: "RPC06", label: "RPC URL with auth .env",         q: 'extension:env "RPC_URL" "SECRET"' },
      ],

      "Payment Gateways": [
        { id: "PG01", label: "Stripe live secret key",          q: 'filename:.env "STRIPE_SECRET_KEY" "sk_live"' },
        { id: "PG02", label: "Coinbase Commerce key",           q: 'filename:.env "COINBASE_COMMERCE_API_KEY"' },
        { id: "PG03", label: "PayPal client+secret",            q: 'filename:.env "PAYPAL_CLIENT_ID" "PAYPAL_SECRET"' },
        { id: "PG04", label: "CoinPayments private key",        q: 'filename:.env "COINPAYMENTS_PRIVATE_KEY"' },
      ],

      "Backup & Exposed Files": [
        { id: "BK01", label: "Backup .bak/.backup files",       q: 'extension:bak "private"' },
        { id: "BK02", label: "Vim swap .swp files",             q: 'extension:swp "private"' },
        { id: "BK03", label: "Temp files with secrets",         q: 'extension:tmp "PRIVATE_KEY"' },
        { id: "BK04", label: "Tilde backup files",              q: 'filename:*.env~ "SECRET"' },
        { id: "BK05", label: "Git config credentials",          q: 'filename:.gitconfig "token"' },
        { id: "BK06", label: "Docker secrets",                  q: 'path:secrets "private_key"' },
      ],
    };
  }

  getCategories() {
    return Object.keys(this._dorks);
  }

  getDorksByCategory(category) {
    const key = Object.keys(this._dorks).find(
      (k) => k.toLowerCase() === category.toLowerCase()
    );
    return key ? this._dorks[key] : null;
  }

  getAllDorks() {
    return Object.entries(this._dorks).flatMap(([category, dorks]) =>
      dorks.map((d) => ({ ...d, category }))
    );
  }

  getTotalCount() {
    return this.getAllDorks().length;
  }

  applyScope(query, scope) {
    if (!scope) return query;
    return `${query} user:${scope}`;
  }
}

// ─── CLASS 3: CredentialValidator ───────────────────────────────────────────
class CredentialValidator {
  static JUNK_VALUES = [
    "test", "example", "dummy", "sample", "demo", "your_", "replace",
    "changeme", "todo", "fixme", "placeholder", "mock", "fake",
    "123456", "000000", "abcdef", "xxxxxxxx", "aaaaaa", "111111",
    "insert", "enter_", "<your", "your-", "here", "paste",
  ];

  static JUNK_PATHS = [
    "/test/", "/tests/", "/example/", "/examples/", "/sample/", "/samples/",
    "/demo/", "/demos/", "/fixtures/", "/__tests__/", "/spec/", "/mocks/",
    "/mock/", "/_test", "/testdata/",
  ];

  static PATTERNS = {
    ETH_PRIVATE_KEY: /^(0x)?[a-fA-F0-9]{64}$/,
    ETH_ADDRESS: /^0x[a-fA-F0-9]{40}$/,
    BTC_WIF_MAINNET: /^[5KL][1-9A-HJ-NP-Za-km-z]{50,52}$/,
    BTC_WIF_TESTNET: /^[c][1-9A-HJ-NP-Za-km-z]{50,52}$/,
    SOLANA_KEYPAIR: /^[1-9A-HJ-NP-Za-km-z]{87,88}$/,
    INFURA_KEY: /^[a-f0-9]{32}$/,
    ALCHEMY_KEY: /^[a-zA-Z0-9_-]{32,}$/,
    BIP39_MNEMONIC_12: /^([a-z]+ ){11}[a-z]+$/,
    BIP39_MNEMONIC_24: /^([a-z]+ ){23}[a-z]+$/,
    STRIPE_LIVE: /^sk_live_[a-zA-Z0-9]{24,}$/,
    STRIPE_TEST: /^sk_test_[a-zA-Z0-9]{24,}$/,
    GITHUB_TOKEN: /^ghp_[a-zA-Z0-9]{36}$/,
    GENERIC_API_KEY: /^[a-zA-Z0-9_\-]{32,}$/,
    HEX_64: /^[a-fA-F0-9]{64}$/,
    BASE58_87: /^[1-9A-HJ-NP-Za-km-z]{87,88}$/,
  };

  static heuristicFilter(value, filePath = "") {
    if (!value || typeof value !== "string") return false;
    const v = value.toLowerCase().trim();
    const p = (filePath || "").toLowerCase();

    // Reject junk values
    for (const junk of CredentialValidator.JUNK_VALUES) {
      if (v.includes(junk)) return false;
    }

    // Reject junk paths
    for (const junkPath of CredentialValidator.JUNK_PATHS) {
      if (p.includes(junkPath)) return false;
    }

    // Reject if value is too short or all same char
    if (v.length < 8) return false;
    if (/^(.)\1+$/.test(v)) return false;

    return true;
  }

  static formatValidate(value, type) {
    const v = (value || "").trim();
    const pattern = CredentialValidator.PATTERNS[type];
    if (!pattern) return null;
    return pattern.test(v);
  }

  static detectTypes(filename, snippet) {
    const detected = [];
    const s = (snippet || "").toLowerCase();
    const f = (filename || "").toLowerCase();

    if (s.includes("private_key") || s.includes("privatekey") || /[a-f0-9]{64}/.test(s))
      detected.push("ETH_PRIVATE_KEY");
    if (s.includes("mnemonic") || s.includes("seed phrase") || s.includes("recovery phrase"))
      detected.push("BIP39_MNEMONIC_12", "BIP39_MNEMONIC_24");
    if (s.includes("sk_live_"))
      detected.push("STRIPE_LIVE");
    if (s.includes("sk_test_"))
      detected.push("STRIPE_TEST");
    if (s.includes("infura"))
      detected.push("INFURA_KEY");
    if (s.includes("alchemy"))
      detected.push("ALCHEMY_KEY");
    if (f.endsWith(".pem") || s.includes("begin") && s.includes("private key"))
      detected.push("PEM_KEY");
    if (s.includes("solana") || s.includes("phantom") || s.includes("secretkey"))
      detected.push("SOLANA_KEYPAIR");
    if (s.includes("wif") || (s.length === 51 || s.length === 52) && /^[5KL]/.test(snippet || ""))
      detected.push("BTC_WIF_MAINNET");

    return detected.length ? detected : ["GENERIC_API_KEY"];
  }

  static assessSeverity(item, category) {
    const text = ((item.text_matches?.[0]?.fragment ?? "") + item.path).toLowerCase();

    if (
      category === "Private Keys" ||
      category === "Seed Phrases & Mnemonics" ||
      text.includes("private_key") || text.includes("mnemonic") ||
      text.includes("seed phrase") || text.includes("begin") && text.includes("private") ||
      text.includes("id_rsa") || text.includes("keystore")
    ) return "CRITICAL";

    if (
      text.includes("api_secret") || text.includes("secret_key") ||
      text.includes("password") || text.includes("jwt_secret") ||
      text.includes("sk_live")
    ) return "HIGH";

    if (
      text.includes("api_key") || text.includes("token") || text.includes("auth") ||
      text.includes("infura") || text.includes("alchemy") || text.includes("rpc_url")
    ) return "MEDIUM";

    return "LOW";
  }

  static validate(finding) {
    const snippet = finding.snippet ?? "";
    const filePath = finding.path ?? "";

    const passed = CredentialValidator.heuristicFilter(snippet, filePath);
    const types = CredentialValidator.detectTypes(finding.filename ?? "", snippet);
    const formatChecks = {};
    for (const type of types) {
      const check = CredentialValidator.formatValidate(snippet.trim(), type);
      if (check !== null) formatChecks[type] = check;
    }

    return {
      heuristic: passed,
      detectedTypes: types,
      formatChecks,
      likelyReal: passed && Object.values(formatChecks).some(Boolean),
    };
  }
}

// ─── CLASS 4: ResultExporter ─────────────────────────────────────────────────
class ResultExporter {
  constructor(format = "json") {
    const valid = ["json", "csv", "txt", "md"];
    this.format = valid.includes(format) ? format : "json";
    this.results = [];
    this.stats = {
      totalQueries: 0,
      totalHits: 0,
      byCritical: 0,
      byHigh: 0,
      byMedium: 0,
      byLow: 0,
      byCategory: {},
    };
  }

  add(result) {
    this.results.push(result);
    this.stats.totalHits++;
    const sev = result.severity ?? "LOW";
    if (sev === "CRITICAL") this.stats.byCritical++;
    else if (sev === "HIGH") this.stats.byHigh++;
    else if (sev === "MEDIUM") this.stats.byMedium++;
    else this.stats.byLow++;

    const cat = result.category ?? "Unknown";
    this.stats.byCategory[cat] = (this.stats.byCategory[cat] ?? 0) + 1;
  }

  incrementQueryCount() {
    this.stats.totalQueries++;
  }

  _toJson() {
    return JSON.stringify(
      {
        generated: new Date().toISOString(),
        tool: "GH Dork CLI",
        stats: this.stats,
        results: this.results,
      },
      null,
      2
    );
  }

  _toCsv() {
    const headers = [
      "severity", "category", "dork_id", "dork_label", "repo", "file_path",
      "file_url", "stars", "last_updated", "snippet", "validation_heuristic",
      "validation_likely_real",
    ];
    const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = this.results.map((r) =>
      [
        r.severity, r.category, r.dorkId, r.dorkLabel, r.repo,
        r.path, r.fileUrl, r.stars, r.lastUpdated,
        (r.snippet ?? "").substring(0, 300),
        r.validation?.heuristic ?? "",
        r.validation?.likelyReal ?? "",
      ]
        .map(escape)
        .join(",")
    );
    return [headers.join(","), ...rows].join("\n");
  }

  _toTxt() {
    const lines = [];
    lines.push("═".repeat(70));
    lines.push("  GH DORK CLI — SCAN RESULTS");
    lines.push(`  Generated: ${new Date().toISOString()}`);
    lines.push("═".repeat(70));
    lines.push(`  Total Hits  : ${this.stats.totalHits}`);
    lines.push(`  Queries Run : ${this.stats.totalQueries}`);
    lines.push(`  CRITICAL    : ${this.stats.byCritical}`);
    lines.push(`  HIGH        : ${this.stats.byHigh}`);
    lines.push(`  MEDIUM      : ${this.stats.byMedium}`);
    lines.push(`  LOW         : ${this.stats.byLow}`);
    lines.push("─".repeat(70));

    for (const r of this.results) {
      lines.push(`\n[${r.severity}] ${r.dorkLabel} (${r.category})`);
      lines.push(`  Repo      : ${r.repo}`);
      lines.push(`  File      : ${r.path}`);
      lines.push(`  URL       : ${r.fileUrl}`);
      lines.push(`  Stars     : ${r.stars}`);
      if (r.snippet) lines.push(`  Snippet   : ${r.snippet.substring(0, 300)}`);
      if (r.validation)
        lines.push(`  Validate  : heuristic=${r.validation.heuristic} likelyReal=${r.validation.likelyReal}`);
      lines.push("─".repeat(70));
    }

    return lines.join("\n");
  }

  _toMarkdown() {
    const lines = [];
    lines.push("# GH Dork CLI — Scan Results");
    lines.push(`\n**Generated:** ${new Date().toISOString()}`);
    lines.push("\n## Summary\n");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Hits | ${this.stats.totalHits} |`);
    lines.push(`| Queries Run | ${this.stats.totalQueries} |`);
    lines.push(`| 🔴 CRITICAL | ${this.stats.byCritical} |`);
    lines.push(`| 🟠 HIGH | ${this.stats.byHigh} |`);
    lines.push(`| 🟡 MEDIUM | ${this.stats.byMedium} |`);
    lines.push(`| ⚪ LOW | ${this.stats.byLow} |`);
    lines.push("\n## Results\n");

    const grouped = {};
    for (const r of this.results) {
      (grouped[r.category] = grouped[r.category] ?? []).push(r);
    }

    for (const [cat, items] of Object.entries(grouped)) {
      lines.push(`\n### ${cat} (${items.length})\n`);
      for (const r of items) {
        const sevEmoji = { CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "⚪" }[r.severity] ?? "⚪";
        lines.push(`#### ${sevEmoji} \`${r.path}\``);
        lines.push(`- **Repo:** [${r.repo}](${r.repoUrl})`);
        lines.push(`- **File:** [${r.path}](${r.fileUrl})`);
        lines.push(`- **Dork:** \`${r.dorkLabel}\` (\`${r.dorkId}\`)`);
        lines.push(`- **Stars:** ${r.stars} | **Updated:** ${r.lastUpdated}`);
        if (r.snippet) {
          lines.push(`\`\`\`\n${r.snippet.substring(0, 400)}\n\`\`\``);
        }
        if (r.validation) {
          lines.push(
            `- **Validation:** heuristic=\`${r.validation.heuristic}\` likelyReal=\`${r.validation.likelyReal}\``
          );
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  serialize() {
    switch (this.format) {
      case "csv": return this._toCsv();
      case "txt": return this._toTxt();
      case "md":  return this._toMarkdown();
      default:    return this._toJson();
    }
  }

  export(filePath) {
    const content = this.serialize();
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  printSummary() {
    log.section("SCAN SUMMARY");
    console.log(`  Queries run  : ${C.bold}${this.stats.totalQueries}${C.reset}`);
    console.log(`  Total hits   : ${C.bold}${this.stats.totalHits}${C.reset}`);
    console.log(`  ${C.red}CRITICAL${C.reset}     : ${C.bold}${this.stats.byCritical}${C.reset}`);
    console.log(`  ${C.yellow}HIGH${C.reset}         : ${C.bold}${this.stats.byHigh}${C.reset}`);
    console.log(`  ${C.cyan}MEDIUM${C.reset}       : ${C.bold}${this.stats.byMedium}${C.reset}`);
    console.log(`  ${C.dim}LOW${C.reset}          : ${C.bold}${this.stats.byLow}${C.reset}`);

    if (Object.keys(this.stats.byCategory).length) {
      console.log(`\n  By category:`);
      for (const [cat, n] of Object.entries(this.stats.byCategory)) {
        console.log(`    ${cat.padEnd(32)} ${C.bold}${n}${C.reset}`);
      }
    }
  }
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key.startsWith("--")) {
      const k = key.slice(2);
      if (!next || next.startsWith("--")) {
        args[k] = true;
      } else {
        args[k] = next;
        i++;
      }
    }
  }
  return args;
}

function printHelp() {
  console.log(`
${C.bold}GH Dork CLI${C.reset} — Blockchain & Crypto Sensitive Data Scanner
${C.dim}──────────────────────────────────────────────────────${C.reset}

${C.bold}Usage:${C.reset}
  GITHUB_TOKEN=ghp_xxx node index.js [options]
  TOKEN_ARRAY=ghp_a,ghp_b,ghp_c node index.js --all

${C.bold}Options:${C.reset}
  --all                    Run all ${new DorkManager().getTotalCount()} dork queries
  --category <name>        Run a specific category
  --query <q>              Run a single custom query
  --scope <user|org>       Scope to GitHub username or org
  --validate               Enable credential validation layer
  --format <json|csv|txt|md>  Output format (default: json)
  --output <file>          Output file (default: auto-named)
  --delay <ms>             Delay between requests (default: 1200)
  --max-results <n>        Results per query (default: 30, max: 100)
  --list-categories        List all categories and dork count
  --verbose                Verbose/debug logging
  --help                   Show this help

${C.bold}Environment Variables:${C.reset}
  GITHUB_TOKEN             Single GitHub PAT (classic, needs 'repo' scope)
  TOKEN_ARRAY              Comma-separated list of tokens for rotation

${C.bold}Examples:${C.reset}
  ${C.cyan}# Run all queries and save as markdown${C.reset}
  GITHUB_TOKEN=ghp_xxx node index.js --all --format md --output report.md

  ${C.cyan}# Scan only exchange API keys, scoped to a user${C.reset}
  GITHUB_TOKEN=ghp_xxx node index.js --category "Exchange API Keys" --scope myuser

  ${C.cyan}# Custom query with validation${C.reset}
  GITHUB_TOKEN=ghp_xxx node index.js --query 'filename:.env PRIVATE_KEY' --validate

  ${C.cyan}# Multi-token rotation for large scans${C.reset}
  TOKEN_ARRAY=ghp_a,ghp_b,ghp_c node index.js --all --delay 800
`);
}

function listCategories(dorkManager) {
  log.section("Available Categories");
  let total = 0;
  for (const cat of dorkManager.getCategories()) {
    const dorks = dorkManager.getDorksByCategory(cat);
    const count = dorks?.length ?? 0;
    total += count;
    console.log(`  ${C.cyan}${cat.padEnd(35)}${C.reset} ${count} queries`);
  }
  console.log(`\n  ${C.bold}Total: ${total} queries${C.reset}`);
}

async function runQuery(client, dorkManager, exporter, dork, opts) {
  const { scope, validate, maxResults, delay, verbose } = opts;
  const query = scope ? dorkManager.applyScope(dork.q, scope) : dork.q;
  const category = dork.category ?? "Custom";

  log.info(`[${dork.id ?? "CUSTOM"}] ${dork.label ?? query}`);
  log.verbose(`Query: ${query}`, verbose);

  exporter.incrementQueryCount();

  try {
    const result = await client.searchCode(query, 1, maxResults);

    if (result._error) {
      log.warn(`Skipped — ${result._error}`);
      return 0;
    }

    const count = result.total_count ?? 0;
    if (count === 0) {
      log.verbose("No results.", verbose);
      return 0;
    }

    log.ok(`Found ${count} results (showing ${result.items?.length ?? 0})`);

    let hits = 0;
    for (const item of result.items ?? []) {
      const snippet = item.text_matches?.[0]?.fragment ?? "";
      const severity = CredentialValidator.assessSeverity(item, category);
      const finding = {
        severity,
        category,
        dorkId: dork.id ?? "CUSTOM",
        dorkLabel: dork.label ?? dork.q,
        repo: item.repository?.full_name ?? "",
        repoUrl: item.repository?.html_url ?? "",
        path: item.path ?? "",
        filename: item.name ?? "",
        fileUrl: item.html_url ?? "",
        stars: item.repository?.stargazers_count ?? 0,
        lastUpdated: item.repository?.updated_at ?? "",
        snippet: snippet,
        rawUrl: item.html_url?.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/") ?? "",
        scannedAt: new Date().toISOString(),
      };

      if (validate) {
        finding.validation = CredentialValidator.validate(finding);
        if (!finding.validation.heuristic) {
          log.verbose(`Filtered (heuristic): ${item.path}`, verbose);
          continue;
        }
      }

      if (severity === "CRITICAL" || severity === "HIGH") {
        log.hit(`${severity} | ${item.repository?.full_name} / ${item.path}`);
      }

      exporter.add(finding);
      hits++;
    }

    return hits;
  } catch (err) {
    log.error(`Query failed: ${err.message}`);
    return 0;
  } finally {
    if (delay > 0) await sleep(delay);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) { printHelp(); process.exit(0); }

  const dorkManager = new DorkManager();

  if (args["list-categories"]) { listCategories(dorkManager); process.exit(0); }

  // Collect tokens
  const tokenEnv = process.env.GITHUB_TOKEN ?? "";
  const arrayEnv = process.env.TOKEN_ARRAY ?? "";
  const tokens = [
    ...tokenEnv.split(",").map((t) => t.trim()).filter(Boolean),
    ...arrayEnv.split(",").map((t) => t.trim()).filter(Boolean),
  ];

  if (!tokens.length) {
    log.error("No GitHub token found. Set GITHUB_TOKEN or TOKEN_ARRAY environment variable.");
    process.exit(1);
  }

  const verbose = !!args.verbose;
  const validate = !!args.validate;
  const delay = parseInt(args.delay ?? "1200", 10);
  const maxResults = Math.min(parseInt(args["max-results"] ?? "30", 10), 100);
  const format = args.format ?? "json";
  const scope = args.scope ?? "";

  // Determine output filename
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext = { json: "json", csv: "csv", txt: "txt", md: "md" }[format] ?? "json";
  const outputFile = args.output ?? `gh-dork-results-${ts}.${ext}`;

  // Select dorks to run
  let dorks = [];

  if (args.query) {
    dorks = [{ id: "CUSTOM", label: args.query, q: args.query, category: "Custom" }];
  } else if (args.category) {
    const catDorks = dorkManager.getDorksByCategory(args.category);
    if (!catDorks) {
      log.error(`Category not found: "${args.category}". Use --list-categories to see options.`);
      process.exit(1);
    }
    dorks = catDorks.map((d) => ({ ...d, category: args.category }));
  } else if (args.all) {
    dorks = dorkManager.getAllDorks();
  } else {
    log.error("Specify --all, --category <name>, or --query <q>. Use --help for usage.");
    process.exit(1);
  }

  const client = new GitHubClient(tokens, verbose);
  const exporter = new ResultExporter(format);

  // Print header
  console.log(`\n${C.bold}${C.blue}╔══════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.blue}║  GH DORK CLI — Crypto Sensitive Data Scanner ║${C.reset}`);
  console.log(`${C.bold}${C.blue}╚══════════════════════════════════════════════╝${C.reset}`);
  console.log(`  Tokens   : ${C.bold}${tokens.length}${C.reset}`);
  console.log(`  Queries  : ${C.bold}${dorks.length}${C.reset}`);
  console.log(`  Validate : ${C.bold}${validate}${C.reset}`);
  console.log(`  Scope    : ${C.bold}${scope || "(none)"}${C.reset}`);
  console.log(`  Format   : ${C.bold}${format}${C.reset}`);
  console.log(`  Output   : ${C.bold}${outputFile}${C.reset}`);
  console.log(`  Delay    : ${C.bold}${delay}ms${C.reset}`);

  // Check rate limit before starting
  try {
    const rl = await client.getRateLimit();
    const search = rl?.resources?.search ?? {};
    log.info(`Rate limit: ${search.remaining ?? "?"}/${search.limit ?? "?"} (resets ${new Date((search.reset ?? 0) * 1000).toLocaleTimeString()})`);
  } catch { /* non-fatal */ }

  // Run queries
  log.section(`Running ${dorks.length} queries`);

  const opts = { scope, validate, maxResults, delay, verbose };
  let totalHits = 0;

  for (let i = 0; i < dorks.length; i++) {
    const dork = dorks[i];
    process.stdout.write(`\r  Progress: ${i + 1}/${dorks.length} `);
    const hits = await runQuery(client, dorkManager, exporter, dork, opts);
    totalHits += hits;
  }
  console.log(); // newline after progress

  // Export results
  if (exporter.results.length > 0) {
    try {
      const saved = exporter.export(outputFile);
      log.ok(`Results saved to: ${C.bold}${saved}${C.reset}`);
    } catch (err) {
      log.error(`Failed to save results: ${err.message}`);
    }
  } else {
    log.warn("No results to export.");
  }

  // Summary
  exporter.printSummary();

  const apiStats = client.getStats();
  console.log(`\n  API requests : ${C.bold}${apiStats.totalRequests}${C.reset}`);
  console.log(`  Tokens used  : ${C.bold}${apiStats.tokenCount}${C.reset}`);
  console.log();
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
