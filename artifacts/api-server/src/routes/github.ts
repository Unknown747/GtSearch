import { Router } from "express";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger";

const router = Router();

// ── Token pool ─────────────────────────────────────────────────────────────────
// Tracks per-token rate-limit state so we always pick the token with the most
// remaining capacity and can wait intelligently when all tokens are exhausted.

interface TokenState {
  token: string;
  remaining: number;   // requests left in current window (updated from headers)
  resetAt: number;     // unix ms when the window resets (0 = unknown)
  lastUsed: number;    // unix ms
  requests: number;    // lifetime request count for this token
  errors: number;      // 401/403 count
}

class TokenPool {
  private states: Map<string, TokenState> = new Map();

  /** Rebuild pool from env vars — call before each use so new tokens are picked up. */
  sync(): void {
    const tokens: string[] = [];
    const single = process.env["GITHUB_TOKEN"];
    if (single) tokens.push(single);
    for (let i = 1; i <= 20; i++) {
      const t = process.env[`TOKEN_${i}`];
      if (t) tokens.push(t);
    }
    const unique = [...new Set(tokens)];

    // Add new tokens; leave existing states intact (preserve remaining/reset data)
    for (const tok of unique) {
      if (!this.states.has(tok)) {
        this.states.set(tok, {
          token: tok,
          remaining: 30,  // conservative default before first response
          resetAt: 0,
          lastUsed: 0,
          requests: 0,
          errors: 0,
        });
      }
    }

    // Remove tokens that are no longer in env
    for (const [tok] of this.states) {
      if (!unique.includes(tok)) this.states.delete(tok);
    }
  }

  get size(): number { return this.states.size; }

  /**
   * Pick the best available token:
   * 1. Filter out tokens with errors >= 3 (treat as invalid).
   * 2. Prefer tokens whose window hasn't reset yet but have remaining > 0.
   * 3. Among eligible tokens, pick the one with the highest remaining count.
   * 4. If all tokens are within an active window but at 0, return null so
   *    the caller can wait for the earliest reset.
   */
  pick(): { token: string; state: TokenState } | null {
    this.sync();
    if (!this.states.size) return null;

    const now = Date.now();
    const candidates: TokenState[] = [];

    for (const state of this.states.values()) {
      if (state.errors >= 3) continue; // effectively dead token

      // If the reset window has passed, reset the remaining count optimistically
      if (state.resetAt > 0 && now >= state.resetAt) {
        state.remaining = 30;
        state.resetAt = 0;
      }

      if (state.remaining > 0) candidates.push(state);
    }

    if (!candidates.length) return null;

    // Pick the token with the most capacity remaining
    candidates.sort((a, b) => b.remaining - a.remaining);
    const best = candidates[0];
    return { token: best.token, state: best };
  }

  /**
   * Like pick(), but excludes tokens currently in use by parallel workers.
   */
  pickExcluding(excluding: ReadonlySet<string>): { token: string; state: TokenState } | null {
    this.sync();
    if (!this.states.size) return null;
    const now = Date.now();
    const candidates: TokenState[] = [];
    for (const state of this.states.values()) {
      if (state.errors >= 3) continue;
      if (excluding.has(state.token)) continue;
      if (state.resetAt > 0 && now >= state.resetAt) { state.remaining = 30; state.resetAt = 0; }
      if (state.remaining > 0) candidates.push(state);
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.remaining - a.remaining);
    return { token: candidates[0].token, state: candidates[0] };
  }

  /**
   * Update a token's rate-limit state from response headers.
   * Returns the updated remaining count.
   */
  update(token: string, remaining: number, resetEpochSec: number | null): void {
    const state = this.states.get(token);
    if (!state) return;
    state.remaining = remaining;
    state.resetAt = resetEpochSec ? resetEpochSec * 1000 : state.resetAt;
    state.lastUsed = Date.now();
    state.requests++;
  }

  /** Mark a token as having produced an auth error. */
  flagError(token: string): void {
    const state = this.states.get(token);
    if (state) state.errors++;
  }

  /**
   * Returns the earliest reset timestamp (ms) across all exhausted tokens,
   * or null if at least one token has remaining capacity.
   */
  earliestReset(): number | null {
    const now = Date.now();
    let earliest: number | null = null;

    for (const state of this.states.values()) {
      if (state.errors >= 3) continue;
      if (state.remaining > 0) return null; // at least one is available
      if (state.resetAt > now) {
        if (earliest === null || state.resetAt < earliest) earliest = state.resetAt;
      }
    }
    return earliest;
  }

  /** Summary for status endpoints (masks the actual token strings). */
  summary(): Array<{
    index: number;
    suffix: string;
    remaining: number;
    resetAt: number | null;
    requests: number;
    errors: number;
  }> {
    let i = 0;
    return [...this.states.values()].map((s) => ({
      index: i++,
      suffix: `...${s.token.slice(-4)}`,
      remaining: s.remaining,
      resetAt: s.resetAt || null,
      requests: s.requests,
      errors: s.errors,
    }));
  }
}

const tokenPool = new TokenPool();

// ── Data directory (outside dist/ so it survives rebuilds) ────────────────────
const _moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(_moduleDir, "..", "data");
const FINDINGS_FILE = path.resolve(DATA_DIR, "findings.json");
const CUSTOM_QUERIES_FILE = path.resolve(DATA_DIR, "custom-queries.json");
const BLOCKLIST_FILE = path.resolve(DATA_DIR, "blocklist.json");

function ensureDataDir(): void {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

// Content fingerprint for hash-based dedup: same URL + changed snippet = new finding
function findingKey(url: string, snippet: string): string {
  const fp = createHash("md5").update(snippet.slice(0, 200)).digest("hex").slice(0, 12);
  return `${url}|${fp}`;
}

// ── Search endpoint rate limiter (10 req/min per IP) ─────────────────────────
const _rlMap = new Map<string, { count: number; ts: number }>();
const RL_MAX = 10;
const RL_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = _rlMap.get(ip);
  if (!entry || now - entry.ts > RL_WINDOW_MS) {
    _rlMap.set(ip, { count: 1, ts: now });
    return true;
  }
  if (entry.count >= RL_MAX) return false;
  entry.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _rlMap) if (now - e.ts > RL_WINDOW_MS * 2) _rlMap.delete(ip);
}, 5 * 60_000).unref?.();

// ── Retry fetch helper ───────────────────────────────────────────────────────
/**
 * Wraps fetch with automatic retry (max 3 attempts, exponential back-off).
 * Does NOT retry 4xx errors (except 429 rate-limit).
 */
async function retryFetch(url: string, options: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
      // Retry only on 429 or 5xx
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = attempt * 1500;
        logger.warn({ err, attempt, url: url.split("?")[0] }, `retryFetch: attempt ${attempt} failed, retrying in ${delayMs}ms`);
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ── Discord & Slack webhook senders ──────────────────────────────────────────
async function sendDiscord(content: string): Promise<void> {
  const url = process.env["DISCORD_WEBHOOK_URL"];
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) logger.warn({ status: res.status }, "Discord webhook failed");
    else logger.info("Discord webhook sent");
  } catch (err) { logger.warn({ err }, "Discord webhook error"); }
}

async function sendSlack(text: string): Promise<void> {
  const url = process.env["SLACK_WEBHOOK_URL"];
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) logger.warn({ status: res.status }, "Slack webhook failed");
    else logger.info("Slack webhook sent");
  } catch (err) { logger.warn({ err }, "Slack webhook error"); }
}

// ── HTML escaper for Telegram messages ───────────────────────────────────────
// Telegram's HTML mode only supports a narrow subset of tags. Repo names,
// file paths, and URLs from GitHub can contain <, >, & — escape them so they
// don't break message structure or inject unintended markup.
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Severity classifier ───────────────────────────────────────────────────────
// Regex patterns that confirm an actual crypto/blockchain secret value is present
const CRITICAL_REGEXES: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,                              // AWS Access Key ID
  /0x[0-9a-fA-F]{64}/,                             // Ethereum/EVM private key (0x-prefixed)
  /\b[0-9a-fA-F]{64}\b/,                           // Raw 32-byte hex key (ETH/BTC/BSC/AVAX/MATIC/TRX)
  /ghp_[A-Za-z0-9]{36}/,                           // GitHub PAT (classic)
  /github_pat_[A-Za-z0-9_]{82}/,                   // GitHub PAT (fine-grained)
  /[5KL][1-9A-HJ-NP-Za-km-z]{50,51}/,             // Bitcoin WIF private key (compressed/uncompressed)
  /ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}/,          // NEAR Protocol private key
  /xprv[A-Za-z0-9]{107}/,                          // BIP32 extended private key (xprv)
  /zprv[A-Za-z0-9]{107}/,                          // BIP84 extended private key (zprv)
  /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/,              // Solana keypair (base58, 64 bytes)
];

/**
 * Returns true when the snippet looks like an empty or placeholder value —
 * e.g. `PRIVATE_KEY=""`, `private_key = None`, `mnemonic = "YOUR_MNEMONIC"`.
 * Used to prevent keyword-based CRITICAL false-positives.
 */
function isPlaceholderValue(snippet: string): boolean {
  const s = snippet;
  // Empty assignment: key=""  key=''  key=  key: ""
  if (/[=:]\s*["']?\s*["']?\s*(?:#.*)?$/.test(s)) return true;
  // Common placeholder / template text
  if (/[=:]\s*["']?\s*(?:your[-_\s]?(?:private[-_\s]?)?(?:key|secret|mnemonic|seed|token)|<[^>]{1,60}>|enter[-_\s]|change[-_\s]me|replace[-_\s]|add[-_\s]your|put[-_\s]your|insert[-_\s]|set[-_\s]your|todo|fixme|example[-_\s]?(?:key|secret)?|sample[-_\s]?(?:key|secret)?|placeholder|x{4,}|\*{4,}|0{8,}|none|null|undefined|n\/a|test[-_\s]?(?:key|secret)?|dummy|fake|mock)/i.test(s)) return true;
  // ALL_CAPS_PLACEHOLDER pattern: = "SOME_KEY_HERE"
  if (/[=:]\s*["'][A-Z_]{4,}(?:HERE|_HERE|_VALUE|_KEY|_SECRET|_TOKEN|_MNEMONIC)["']/.test(s)) return true;
  // Django insecure default: SECRET_KEY = 'django-insecure-...'
  if (/django-insecure/i.test(s)) return true;
  // Very short hex that cannot be a real private key (< 32 hex chars)
  if (/[=:]\s*["']?0x[0-9a-fA-F]{1,30}["']?\s*$/.test(s) && !/0x[0-9a-fA-F]{40,}/.test(s)) return true;
  return false;
}

/**
 * Extracts and censors the detected secret value from a snippet.
 * Returns a string like "ETH Key: 0xABCD...ef12" or "Mnemonic: word1 word2 ... wordN [12 words]".
 * Returns empty string if no recognisable value is found.
 */
function extractValuePreview(snippet: string, _filePath: string): string {
  // 1. Regex-confirmed key formats — censor middle, keep prefix + last 4
  const patterns: Array<{ re: RegExp; label: string; censor: (m: string) => string }> = [
    { re: /AKIA[0-9A-Z]{16}/,               label: "AWS Key",    censor: m => m.slice(0, 8)  + "..." + m.slice(-4) },
    { re: /0x[0-9a-fA-F]{64}/,              label: "ETH Key",    censor: m => m.slice(0, 6)  + "..." + m.slice(-4) },
    { re: /\b[0-9a-fA-F]{64}\b/,            label: "Hex Key",    censor: m => m.slice(0, 4)  + "..." + m.slice(-4) },
    { re: /ghp_[A-Za-z0-9]{36}/,            label: "GH Token",   censor: m => m.slice(0, 8)  + "..." + m.slice(-4) },
    { re: /github_pat_[A-Za-z0-9_]{82}/,    label: "GH Token",   censor: m => m.slice(0, 14) + "..." + m.slice(-4) },
    { re: /xprv[A-Za-z0-9]{107}/,           label: "xprv",       censor: m => m.slice(0, 8)  + "..." + m.slice(-4) },
    { re: /zprv[A-Za-z0-9]{107}/,           label: "zprv",       censor: m => m.slice(0, 8)  + "..." + m.slice(-4) },
    { re: /ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}/, label: "NEAR Key", censor: m => m.slice(0, 12) + "..." + m.slice(-4) },
    { re: /[5KL][1-9A-HJ-NP-Za-km-z]{50,51}/, label: "BTC WIF",  censor: m => m.slice(0, 4)  + "..." + m.slice(-4) },
    { re: /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/, label: "Solana Key", censor: m => m.slice(0, 4) + "..." + m.slice(-4) },
  ];
  for (const { re, label, censor } of patterns) {
    const m = snippet.match(re);
    if (m) return `${label}: ${censor(m[0])}`;
  }

  // 2. Mnemonic phrase — 12 or 24 lowercase words separated by spaces
  const mnemonicM = snippet.match(/\b([a-z]{3,10}(?:[ \t]+[a-z]{3,10}){11,23})\b/);
  if (mnemonicM) {
    const words = mnemonicM[1].trim().split(/\s+/);
    if (words.length >= 12) {
      return `Mnemonic: ${words[0]} ${words[1]} ... ${words[words.length - 1]} [${words.length} words]`;
    }
  }

  // 3. Assignment pattern — KEY = "value" or KEY: 'value'
  const assignM = snippet.match(
    /(?:private_?key|mnemonic|seed(?:_phrase)?|secret|password|api_?(?:key|secret)|token)\s*[=:]\s*["']?([^\s"'#,;|\n\\]{8,})/i
  );
  if (assignM) {
    const val = assignM[1].replace(/["',;)]+$/, "");
    if (val.length <= 8) return val.slice(0, 2) + "***" + val.slice(-2);
    return val.slice(0, 4) + "..." + val.slice(-4);
  }

  return "";
}

/**
 * Computes a 0–100 confidence score for a finding based on multiple signals.
 * Higher = more likely a real secret, not a placeholder or test file.
 */
function confidenceScore(filePath: string, snippet: string, sev: string): number {
  let score = 0;
  // Base from severity
  if (sev === "CRITICAL") score += 50;
  else if (sev === "HIGH") score += 30;
  else score += 10;

  // Regex-confirmed key format (+25)
  if (CRITICAL_REGEXES.some(re => re.test(snippet))) score += 25;

  // Not a placeholder (-20)
  if (!isPlaceholderValue(snippet)) score += 10;
  else score -= 20;

  // Not a test/example file (+10 / -15)
  if (!isExampleOrTestFile(filePath)) score += 10;
  else score -= 15;

  // Real assignment pattern present (+5)
  if (/[=:]\s*["']?[0-9a-zA-Z+/]{20,}/.test(snippet)) score += 5;

  // Path hints it's a real config file (+5)
  const lo = filePath.toLowerCase();
  if (lo.includes(".env") || lo.includes("config") || lo.includes("secret") || lo.includes("credential")) score += 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * Returns true for file paths that are almost certainly template / test / doc files
 * rather than real configuration with actual secrets.
 */
function isExampleOrTestFile(filePath: string): boolean {
  const lo = filePath.toLowerCase();
  return (
    lo.includes(".example") || lo.includes(".sample") || lo.includes(".template") ||
    lo.endsWith(".md") || lo.endsWith(".mdx") || lo.endsWith(".txt") || lo.endsWith(".rst") ||
    lo.includes("_test.") || lo.includes(".test.") || lo.includes("/test/") || lo.includes("/tests/") ||
    lo.includes("_spec.") || lo.includes(".spec.") || lo.includes("/spec/") || lo.includes("/specs/") ||
    lo.includes("/fixture") || lo.includes("/mock") || lo.includes("/mocks/") ||
    lo.includes("/example") || lo.includes("/examples/") ||
    lo.includes("/docs/") || lo.includes("/doc/")
  );
}

// ── Utility: filter recent repos, validate keys, deduplicate ─────────────────

/** Keep only items whose repo was pushed/updated within maxAgeDays. */
function filterRecentRepos<T extends { repository: { pushed_at?: string; updated_at?: string } }>(
  items: T[],
  maxAgeDays = 30,
): T[] {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return items.filter((item) => {
    const dateStr = item.repository.pushed_at ?? item.repository.updated_at ?? "";
    return dateStr ? new Date(dateStr).getTime() >= cutoff : true;
  });
}

const DUMMY_KEY_PATTERNS: RegExp[] = [
  /^0{32,}$/,
  /^f{32,}$/i,
  /^x{8,}$/i,
  /\*{8,}/,
  /your[_-]?(private[_-]?)?key/i,
  /replace[_-]?me/i,
  /change[_-]?me/i,
  /enter[_-]?your/i,
  /add[_-]?your/i,
  /insert[_-]?your/i,
  /example[_-]?key/i,
  /test[_-]?key/i,
  /dummy[_-]?key/i,
  /fake[_-]?key/i,
];

/**
 * Returns true when a string looks like a real private key (not a placeholder).
 * Validates known key formats and filters dummy/placeholder patterns.
 */
function isValidPrivateKey(value: string): boolean {
  if (!value || value.length < 32) return false;
  const trimmed = value.trim();
  if (DUMMY_KEY_PATTERNS.some((re) => re.test(trimmed))) return false;
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return true;      // ETH 0x-prefixed
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return true;         // Raw 32-byte hex
  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(trimmed)) return true; // BTC WIF
  if (/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(trimmed)) return true;      // Solana
  if (/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(trimmed)) return true; // NEAR
  if (/^[xz]prv[A-Za-z0-9]{107}$/.test(trimmed)) return true; // BIP32/84
  return false;
}

const DUMMY_SEED_WORDS = new Set([
  "test", "example", "word", "replace", "your", "here", "fill",
  "enter", "sample", "dummy", "fake", "insert", "placeholder",
]);

/**
 * Returns true when the string appears to be a real 12 or 24-word BIP39 seed phrase.
 * All words must be lowercase 3–8 character alphabetic strings with no dummy words.
 */
function isValidSeedPhrase(value: string): boolean {
  if (!value) return false;
  const words = value.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) return false;
  if (words.some((w) => DUMMY_SEED_WORDS.has(w.toLowerCase()))) return false;
  return words.every((w) => /^[a-z]{3,8}$/.test(w));
}

/**
 * Remove duplicate results based on repository full_name + file path.
 * Keeps the first occurrence of each unique repo+path pair.
 */
function deduplicateResults<T extends { path?: string; repository?: { full_name?: string; html_url?: string } }>(
  items: T[],
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const repo = item.repository?.full_name ?? item.repository?.html_url ?? "";
    const filePath = item.path ?? "";
    const key = `${repo}::${filePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function severity(filePath: string, snippet: string): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const raw = filePath + " " + snippet;
  const t = raw.toLowerCase();

  // ── CRITICAL: regex confirms actual key value present (always trust format) ─
  for (const re of CRITICAL_REGEXES) { if (re.test(raw)) return "CRITICAL"; }

  // ── CRITICAL: keywords only when value is NOT a placeholder/empty ─────────
  const hasCriticalKeyword = (
    // Generic key/seed terms
    t.includes("private_key") || t.includes("privatekey") ||
    t.includes("mnemonic") || t.includes("seed phrase") || t.includes("seed_phrase") ||
    t.includes("seedphrase") || t.includes("secret_recovery_phrase") ||
    t.includes("recovery phrase") || t.includes("recovery_phrase") ||
    t.includes("wallet_mnemonic") || t.includes("wallet_seed") ||
    t.includes("wallet_private") || t.includes("wallet_secret") ||
    t.includes("keystore") || t.includes("ciphertext") ||
    t.includes("begin rsa") || t.includes("begin openssh") || t.includes("id_rsa") ||
    // Ethereum / EVM
    t.includes("eth_private") || t.includes("ethereum_private") ||
    t.includes("evm_private") || t.includes("deployer_key") ||
    t.includes("deployer_private") || t.includes("signer_private") ||
    // Bitcoin
    t.includes("btc_private") || t.includes("bitcoin_private") ||
    t.includes("btc_wif") || t.includes("bitcoin_wif") ||
    t.includes("xprivkey") || t.includes("master_private") ||
    // Solana
    t.includes("sol_private") || t.includes("solana_private") ||
    t.includes("solana_secret") || t.includes("sol_secret") ||
    t.includes("phantom_private") || t.includes("phantom_secret") ||
    t.includes("solana_keypair") || t.includes("sol_keypair") ||
    // NEAR Protocol
    t.includes("near_private_key") || t.includes("near_secret") ||
    // Tron / TRX
    t.includes("tron_private") || t.includes("trx_private") ||
    t.includes("tron_key") || t.includes("trx_key") ||
    // Avalanche / AVAX
    t.includes("avax_private") || t.includes("avalanche_private") ||
    // Polygon / MATIC
    t.includes("matic_private") || t.includes("polygon_private") ||
    // BSC / BNB
    t.includes("bsc_private") || t.includes("bnb_private") ||
    // Cosmos / Terra
    t.includes("cosmos_mnemonic") || t.includes("terra_mnemonic") ||
    t.includes("cosmos_key") || t.includes("terra_key") ||
    // Polkadot / Substrate
    t.includes("dot_mnemonic") || t.includes("polkadot_mnemonic") ||
    t.includes("substrate_seed") ||
    // Wallet files
    t.includes("keypair.json") || t.includes("wallet.dat") ||
    t.includes("utc--")
  );
  if (hasCriticalKeyword && !isPlaceholderValue(snippet) && !isExampleOrTestFile(filePath)) return "CRITICAL";

  // ── HIGH: exchange API secrets & trading credentials ───────────────────────
  if (
    t.includes("secret") || t.includes("api_secret") ||
    t.includes("password") || t.includes("jwt_secret") || t.includes("sk_live") ||
    // Tier-1 Exchanges
    (t.includes("api_key") && t.includes("binance")) ||
    t.includes("kraken") || t.includes("coinbase") ||
    t.includes("bybit") || t.includes("okx") || t.includes("okex") ||
    t.includes("kucoin") || t.includes("huobi") || t.includes("htx") ||
    // Tier-2 Exchanges
    t.includes("gateio") || t.includes("gate_io") ||
    t.includes("bitget") || t.includes("mexc") || t.includes("bitmart") ||
    t.includes("bitmex") || t.includes("deribit") || t.includes("phemex") ||
    t.includes("poloniex") || t.includes("whitebit") || t.includes("lbank") ||
    t.includes("ascendex") || t.includes("bitrue") || t.includes("probit") ||
    t.includes("bitkub") || t.includes("coindcx") || t.includes("wazirx") ||
    t.includes("zebpay") || t.includes("bitbns") ||
    // Indonesian & SEA Exchanges
    t.includes("indodax") || t.includes("tokocrypto") || t.includes("pintu") ||
    t.includes("rekeningku") || t.includes("nanovest") ||
    // Legacy / defunct
    t.includes("ftx") || t.includes("bitfinex") || t.includes("bitstamp") ||
    t.includes("gemini") || t.includes("cryptocom") || t.includes("crypto_com") ||
    // DeFi protocols with API/admin keys
    t.includes("flashbots") || t.includes("relayer_key") || t.includes("operator_key")
  ) return "HIGH";

  // ── MEDIUM: RPC endpoints, node infra, block explorers ────────────────────
  if (
    t.includes("api_key") || t.includes("rpc_url") ||
    // EVM RPC Providers
    t.includes("infura") || t.includes("alchemy") || t.includes("quicknode") ||
    t.includes("moralis") || t.includes("ankr") || t.includes("chainstack") ||
    t.includes("blastapi") || t.includes("getblock") || t.includes("nownodes") ||
    t.includes("drpc") || t.includes("lavanetwork") || t.includes("chainbase") ||
    t.includes("blocknative") || t.includes("pokt") ||
    // Solana RPC Providers
    t.includes("helius") || t.includes("triton") || t.includes("shyft") ||
    // Block Explorers (API keys)
    t.includes("etherscan") || t.includes("bscscan") || t.includes("polygonscan") ||
    t.includes("snowtrace") || t.includes("arbiscan") || t.includes("optimistic") ||
    t.includes("basescan") || t.includes("solscan") || t.includes("tronscan") ||
    t.includes("nearblocks") || t.includes("celoscan") || t.includes("ftmscan") ||
    // Indexing / Data
    t.includes("thegraph") || t.includes("the_graph") || t.includes("subgraph") ||
    t.includes("covalent") || t.includes("transpose") || t.includes("bitquery") ||
    // NFT / IPFS
    t.includes("pinata") || t.includes("nftstorage") || t.includes("web3storage") ||
    t.includes("infura") || t.includes("filebase") ||
    // Wallet / Auth
    t.includes("walletconnect") || t.includes("web3auth") || t.includes("privy") ||
    t.includes("dynamic_xyz") || t.includes("particle_network") ||
    // Token
    t.includes("token")
  ) return "MEDIUM";

  return "LOW";
}

// ── Telegram notifier (manual search) ────────────────────────────────────────
interface Finding {
  severity: string;
  repo: string;
  path: string;
  fileUrl: string;
  snippet: string;
}

async function sendTelegram(query: string, findings: Finding[]): Promise<void> {
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!botToken || !chatId) return;

  const critical = findings.filter((f) => f.severity === "CRITICAL");
  const high = findings.filter((f) => f.severity === "HIGH");
  if (!critical.length && !high.length) return;

  const header = [
    `🔴 <b>GH Dork — Crypto Data Exposed</b>`,
    ``,
    `🔍 Query: <code>${escHtml(query.substring(0, 120))}</code>`,
    ``,
    critical.length ? `💀 <b>CRITICAL:</b> ${critical.length} temuan` : null,
    high.length ? `🟠 <b>HIGH:</b> ${high.length} temuan` : null,
    ``,
  ].filter((l) => l !== null).join("\n");

  const top = [...critical, ...high].slice(0, 5);
  const body = top.map((f, i) =>
    `${i + 1}. ${f.severity === "CRITICAL" ? "🔴" : "🟠"} <b>${escHtml(f.repo)}</b>\n` +
    `   📄 <code>${escHtml(f.path)}</code>\n` +
    `   🔗 ${escHtml(f.fileUrl)}`
  ).join("\n\n");

  const footer = findings.length > 5 ? `\n\n<i>...dan ${findings.length - 5} temuan lainnya</i>` : "";

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: header + body + footer,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) logger.warn({ status: res.status }, "Telegram notification failed");
    else logger.info({ count: findings.length }, "Telegram notification sent");
  } catch (err) {
    logger.warn({ err }, "Telegram notification error");
  }

  // Discord & Slack (plain text version)
  const plainLines = [
    `🔴 GH Dork — Crypto Data Exposed`,
    `🔍 Query: ${query.substring(0, 120)}`,
    critical.length ? `💀 CRITICAL: ${critical.length} temuan` : null,
    high.length ? `🟠 HIGH: ${high.length} temuan` : null,
    ...top.map((f, i) =>
      `${i + 1}. ${f.severity === "CRITICAL" ? "🔴" : "🟠"} ${f.repo} / ${f.path}\n   ${f.fileUrl}`
    ),
    findings.length > 5 ? `...dan ${findings.length - 5} temuan lainnya` : null,
  ].filter(Boolean).join("\n");
  void sendDiscord(plainLines);
  void sendSlack(plainLines);
}

// ── Auto-scan ─────────────────────────────────────────────────────────────────
let currentScanIntervalMs = 30 * 60 * 1000; // 30 min default — always scan fresh
let currentScanWindowDays = 14; // rolling window for pushed: filter (days)
// Adaptive delay: ~1.5 s base; increases when remaining tokens are low
const BASE_QUERY_DELAY_MS = 1500;

/**
 * Returns a polite pause duration. If the best token has < 8 requests left,
 * slow down to avoid hitting the wall mid-scan.
 */
function queryDelayMs(): number {
  const pick = tokenPool.pick();
  if (!pick) return BASE_QUERY_DELAY_MS;
  return pick.state.remaining < 8 ? 3500 : BASE_QUERY_DELAY_MS;
}

const AUTO_SCAN_QUERIES: Array<{ label: string; q: string }> = [
  // ── Seed phrases & mnemonics ─────────────────────────────────────────────
  { label: "mnemonic .env",              q: 'filename:.env "MNEMONIC" NOT example NOT sample NOT template' },
  { label: "PRIVATE_KEY .env",           q: 'filename:.env "PRIVATE_KEY" NOT example NOT sample NOT template' },
  { label: "seed phrase .env",           q: 'filename:.env "SEED_PHRASE" OR "SECRET_RECOVERY_PHRASE" NOT example NOT sample' },
  { label: "Trust Wallet mnemonic",      q: '"trustwallet" "mnemonic" extension:json NOT test NOT example' },
  { label: "MetaMask seed words",        q: '"metamask" "seed" "words" extension:json NOT test NOT example' },
  { label: "seed phrase JS",             q: '"bip39" "mnemonic" "entropy" language:javascript NOT test NOT spec' },
  { label: ".env.production key",        q: 'filename:.env.production "PRIVATE_KEY" OR "MNEMONIC"' },
  { label: ".env.local key",             q: 'filename:.env.local "PRIVATE_KEY" OR "MNEMONIC" NOT example NOT sample' },

  // ── EVM Chains (ETH / BSC / AVAX / MATIC / ARB / OP) ────────────────────
  { label: "ETH private key .env",       q: 'filename:.env "ETH_PRIVATE_KEY" OR "ETHEREUM_PRIVATE_KEY" NOT example NOT sample' },
  { label: "BSC private key",            q: 'filename:.env "BSC_PRIVATE_KEY" OR "BNB_PRIVATE_KEY" NOT example NOT sample' },
  { label: "AVAX private key",           q: 'filename:.env "AVAX_PRIVATE_KEY" OR "AVALANCHE_PRIVATE_KEY" NOT example NOT sample' },
  { label: "MATIC private key",          q: 'filename:.env "MATIC_PRIVATE_KEY" OR "POLYGON_PRIVATE_KEY" NOT example NOT sample' },
  { label: "deployer key",               q: '"DEPLOYER_PRIVATE_KEY" filename:.env NOT example NOT sample' },
  { label: "signer private key",         q: 'filename:.env "SIGNER_PRIVATE_KEY" OR "OPERATOR_PRIVATE_KEY" NOT example NOT sample' },

  // ── Solana ────────────────────────────────────────────────────────────────
  { label: "Solana private key",         q: 'filename:.env "SOLANA_PRIVATE_KEY" OR "SOL_PRIVATE_KEY" NOT example NOT sample' },
  { label: "Phantom wallet key",         q: 'filename:.env "PHANTOM_PRIVATE_KEY" NOT example NOT sample' },
  { label: "Solana keypair.json",        q: 'filename:keypair.json extension:json language:json "[" NOT test NOT example' },
  { label: "Anchor wallet keypair",      q: 'filename:id.json path:.config/solana "[1," OR "[2,"' },

  // ── NEAR Protocol ─────────────────────────────────────────────────────────
  { label: "NEAR private key",           q: 'filename:.env "NEAR_PRIVATE_KEY" OR "NEAR_SECRET" NOT example NOT sample' },
  { label: "NEAR credentials file",      q: 'filename:credentials.json "ed25519:" path:.near' },

  // ── Tron / TRX ───────────────────────────────────────────────────────────
  { label: "Tron private key",           q: 'filename:.env "TRON_PRIVATE_KEY" OR "TRX_PRIVATE_KEY" NOT example NOT sample' },
  { label: "Tron key JS",                q: 'language:javascript "TronWeb" "privateKey" NOT test NOT spec NOT mock' },

  // ── Cosmos / Terra / Polkadot ─────────────────────────────────────────────
  { label: "Cosmos mnemonic",            q: 'filename:.env "COSMOS_MNEMONIC" OR "TERRA_MNEMONIC" NOT example NOT sample' },
  { label: "Polkadot seed",              q: 'filename:.env "DOT_MNEMONIC" OR "POLKADOT_MNEMONIC" OR "SUBSTRATE_SEED" NOT example NOT sample' },

  // ── Wallet files ─────────────────────────────────────────────────────────
  { label: "Ethereum keystore.json",     q: 'filename:keystore.json "version" "crypto" "ciphertext" NOT test NOT example' },
  { label: "UTC-- wallet file",          q: 'filename:UTC-- "ciphertext"' },
  { label: "wallet.json ciphertext",     q: 'filename:wallet.json "crypto" "ciphertext" NOT test NOT example' },
  { label: "MetaMask vault",             q: 'filename:vault.json "data" "iv" "salt" NOT test NOT example' },
  { label: "Exodus wallet backup",       q: 'filename:exodus.wallet.bak OR filename:exodus-backup' },
  { label: "BIP32 xprv key",            q: '"xprv" extension:json OR extension:txt OR extension:env NOT example NOT test' },

  // ── Exchange API Keys ─────────────────────────────────────────────────────
  { label: "Binance API key",            q: 'filename:.env "BINANCE_API_KEY" NOT example NOT sample' },
  { label: "Coinbase API key",           q: 'filename:.env "COINBASE_API_KEY" NOT example NOT sample' },
  { label: "Kraken API key",             q: 'filename:.env "KRAKEN_API_KEY" NOT example NOT sample' },
  { label: "Bybit API key",             q: 'filename:.env "BYBIT_API_KEY" NOT example NOT sample' },
  { label: "OKX API key",               q: 'filename:.env "OKX_API_KEY" OR "OKEX_API_KEY" NOT example NOT sample' },
  { label: "KuCoin API key",             q: 'filename:.env "KUCOIN_API_KEY" OR "KUCOIN_KEY" NOT example NOT sample' },
  { label: "Huobi / HTX API key",        q: 'filename:.env "HUOBI_API_KEY" OR "HTX_API_KEY" NOT example NOT sample' },
  { label: "Gate.io API key",            q: 'filename:.env "GATE_API_KEY" OR "GATEIO_API_KEY" NOT example NOT sample' },
  { label: "Bitget API key",             q: 'filename:.env "BITGET_API_KEY" NOT example NOT sample' },
  { label: "MEXC API key",               q: 'filename:.env "MEXC_API_KEY" NOT example NOT sample' },
  { label: "Indodax / Tokocrypto key",   q: 'filename:.env "INDODAX_API_KEY" OR "TOKOCRYPTO_API_KEY" NOT example NOT sample' },

  // ── Smart contract / DeFi ────────────────────────────────────────────────
  { label: "Hardhat private key JS",     q: 'filename:hardhat.config.js "PRIVATE_KEY" NOT example NOT test' },
  { label: "Hardhat private key TS",     q: 'filename:hardhat.config.ts "PRIVATE_KEY" OR "mnemonic" NOT example NOT test' },
  { label: "Truffle mnemonic",           q: 'filename:truffle-config.js "mnemonic" NOT example NOT test' },
  { label: "Foundry private_key",        q: 'filename:foundry.toml "private_key" NOT example NOT test' },
  { label: "Anchor deploy key",          q: 'filename:Anchor.toml "wallet" path:.config/solana' },

  // ── RPC / Node Infrastructure ─────────────────────────────────────────────
  { label: "Infura Project ID",          q: 'filename:.env "INFURA_PROJECT_ID" NOT example NOT sample' },
  { label: "Alchemy API key",            q: 'filename:.env "ALCHEMY_API_KEY" NOT example NOT sample' },
  { label: "Helius API key (Solana)",    q: 'filename:.env "HELIUS_API_KEY" NOT example NOT sample' },
  { label: "QuickNode token",            q: 'filename:.env "QUICKNODE_TOKEN" OR "QUICKNODE_API_KEY" NOT example NOT sample' },
  { label: "Moralis API key",            q: 'filename:.env "MORALIS_API_KEY" NOT example NOT sample' },
  { label: "Ankr API key",              q: 'filename:.env "ANKR_API_KEY" NOT example NOT sample' },

  // ── NFT & IPFS ────────────────────────────────────────────────────────────
  { label: "Pinata IPFS key",            q: 'filename:.env "PINATA_API_KEY" "PINATA_SECRET" NOT example NOT sample' },
  { label: "NFT Storage key",            q: 'filename:.env "NFT_STORAGE_API_KEY" NOT example NOT sample' },
  { label: "OpenSea API key",            q: 'filename:.env "OPENSEA_API_KEY" NOT example NOT sample' },

  // ── GitHub Actions / CI-CD ───────────────────────────────────────────────
  { label: "PRIVATE_KEY in workflow",    q: 'path:.github/workflows "PRIVATE_KEY" extension:yml NOT example' },
  { label: "MNEMONIC in workflow",       q: 'path:.github/workflows "MNEMONIC" extension:yml NOT example' },
  { label: "BEGIN RSA in workflow",      q: 'path:.github/workflows "BEGIN RSA PRIVATE KEY"' },
  { label: "hardcoded PAT in CI",        q: 'path:.github/workflows "ghp_" OR "github_pat_"' },

  // ── SSH Keys ──────────────────────────────────────────────────────────────
  { label: "OpenSSH Private Key",        q: '"BEGIN OPENSSH PRIVATE KEY"' },
  { label: "RSA Private Key",            q: '"BEGIN RSA PRIVATE KEY"' },

  // ── Python ────────────────────────────────────────────────────────────────
  { label: "Python private key",         q: 'language:python "PRIVATE_KEY" OR "private_key" NOT test NOT spec NOT mock NOT example' },
  { label: "Python mnemonic",            q: 'language:python "mnemonic" OR "seed_phrase" NOT test NOT spec NOT example' },
  { label: "Django SECRET_KEY",          q: 'filename:settings.py "SECRET_KEY" NOT "django-insecure" NOT example NOT test' },
  { label: "Python web3 privateKey",     q: 'language:python "web3" "private_key" NOT "test"' },
  { label: "Python AWS credential",      q: 'language:python "aws_access_key_id" "aws_secret_access_key"' },

  // ── Go ────────────────────────────────────────────────────────────────────
  { label: "Go private key",             q: 'language:go "privateKey" OR "PrivateKey" NOT test NOT mock NOT example' },
  { label: "Go mnemonic",                q: 'language:go "mnemonic" NOT test NOT mock NOT example' },
  { label: "Go ethclient key",           q: 'language:go "ethclient" "private" NOT test NOT mock' },
  { label: "Go config private",          q: 'filename:config.go "PRIVATE_KEY" OR "PrivateKey" NOT test NOT example' },

  // ── Rust ──────────────────────────────────────────────────────────────────
  { label: "Rust private key",           q: 'language:rust "private_key" OR "PRIVATE_KEY" NOT test NOT mock NOT example' },
  { label: "Rust mnemonic",              q: 'language:rust "mnemonic" NOT test NOT mock NOT example' },
  { label: "Rust Solana keypair",        q: 'language:rust "solana" "keypair" "secret" NOT test NOT mock' },
  { label: "Rust ethers key",            q: 'language:rust "ethers" "private_key" NOT test NOT mock' },

  // ── More .env file variants ───────────────────────────────────────────────
  { label: ".env.staging key",           q: 'filename:.env.staging "PRIVATE_KEY" OR "MNEMONIC"' },
  { label: ".env.develop key",           q: 'filename:.env.develop "PRIVATE_KEY" OR "MNEMONIC"' },
  { label: ".env.ci key",                q: 'filename:.env.ci "PRIVATE_KEY" OR "MNEMONIC"' },
  { label: ".env.test key",              q: 'filename:.env.test "PRIVATE_KEY" OR "MNEMONIC"' },
  { label: ".env.backup key",            q: 'filename:.env.backup "PRIVATE_KEY" OR "MNEMONIC"' },
  { label: ".env.prod key",              q: 'filename:.env.prod "PRIVATE_KEY" OR "MNEMONIC"' },
  { label: ".env.mainnet key",           q: 'filename:.env.mainnet "PRIVATE_KEY" OR "MNEMONIC"' },
  { label: ".env.testnet key",           q: 'filename:.env.testnet "PRIVATE_KEY" OR "MNEMONIC"' },

  // ── Ethers.js / Web3.js hardcoded patterns ────────────────────────────────
  { label: "ethers Wallet.fromMnemonic", q: '"Wallet.fromMnemonic" language:javascript NOT test NOT spec NOT mock' },
  { label: "ethers new Wallet key",      q: '"new ethers.Wallet" language:javascript NOT test NOT spec NOT mock' },
  { label: "ethers Wallet.fromPhrase",   q: '"Wallet.fromPhrase" language:javascript NOT test NOT spec NOT mock' },
  { label: "ethers TS Wallet key",       q: '"new ethers.Wallet" language:typescript NOT test NOT spec NOT mock' },
  { label: "web3 accounts.privateToAccount", q: '"privateToAccount" language:javascript NOT test NOT spec NOT mock' },
  { label: "viem privateKeyToAccount",   q: '"privateKeyToAccount" language:typescript NOT test NOT spec NOT mock' },

  // ── TypeScript private key patterns ──────────────────────────────────────
  { label: "TS hardcoded private key",   q: 'language:typescript "PRIVATE_KEY" NOT test NOT spec NOT mock NOT example NOT type' },
  { label: "TS mnemonic hardcoded",      q: 'language:typescript "mnemonic" NOT test NOT spec NOT mock NOT example NOT interface' },

  // ── Solana JS/TS SDK patterns ─────────────────────────────────────────────
  { label: "Solana Keypair.fromSecret",  q: '"Keypair.fromSecretKey" NOT test NOT spec NOT mock NOT example' },
  { label: "Solana bs58 secret key",     q: '"bs58.decode" "secretKey" NOT test NOT spec NOT mock' },
  { label: "Solana wallet adapter key",  q: '"solanaKeypair" OR "solana_keypair" extension:json NOT test NOT example' },

  // ── Python DeFi / Web3 patterns ──────────────────────────────────────────
  { label: "Brownie mnemonic config",    q: 'filename:brownie-config.yaml "mnemonic" NOT example NOT test' },
  { label: "Python eth_account key",     q: 'language:python "eth_account" "private_key" NOT test NOT spec NOT mock' },
  { label: "Python Account.from_key",    q: 'language:python "Account.from_key" NOT test NOT spec NOT mock' },
  { label: "Python hdwallet mnemonic",   q: 'language:python "HDWallet" "mnemonic" NOT test NOT spec NOT example' },

  // ── Deployment & migration scripts ───────────────────────────────────────
  { label: "deploy.js private key",      q: 'filename:deploy.js "PRIVATE_KEY" OR "privateKey" NOT test NOT example' },
  { label: "deploy.ts private key",      q: 'filename:deploy.ts "PRIVATE_KEY" OR "privateKey" NOT test NOT example' },
  { label: "deploy.py private key",      q: 'filename:deploy.py "PRIVATE_KEY" OR "private_key" NOT test NOT example' },
  { label: "migration private key",      q: 'filename:migrate.js "PRIVATE_KEY" OR "mnemonic" NOT test NOT example' },
  { label: "script dir .env private",   q: 'path:scripts filename:.env "PRIVATE_KEY" OR "MNEMONIC"' },

  // ── CI/CD infrastructure files ────────────────────────────────────────────
  { label: "docker-compose PRIVATE_KEY", q: 'filename:docker-compose.yml "PRIVATE_KEY" OR "MNEMONIC" NOT example' },
  { label: "CircleCI private key",       q: 'path:.circleci "PRIVATE_KEY" OR "MNEMONIC" NOT example' },
  { label: "GitLab CI private key",      q: 'filename:.gitlab-ci.yml "PRIVATE_KEY" OR "MNEMONIC" NOT example' },
  { label: "Jenkinsfile private key",    q: 'filename:Jenkinsfile "PRIVATE_KEY" OR "MNEMONIC" NOT example' },

  // ── Config & secrets files ────────────────────────────────────────────────
  { label: "config.json private key",    q: 'filename:config.json "private_key" OR "privateKey" NOT test NOT example' },
  { label: "config.yaml private key",    q: 'filename:config.yaml "private_key" OR "mnemonic" NOT test NOT example' },
  { label: "config.yml private key",     q: 'filename:config.yml "private_key" OR "mnemonic" NOT test NOT example' },
  { label: "secrets.json private key",   q: 'filename:secrets.json "private_key" OR "mnemonic" NOT test' },
  { label: "secrets.yaml private key",   q: 'filename:secrets.yaml "private_key" OR "mnemonic" NOT test' },
  { label: "appsettings private key",    q: 'filename:appsettings.json "privateKey" OR "mnemonic" NOT test NOT example' },

  // ── Terraform / IaC patterns ──────────────────────────────────────────────
  { label: "Terraform private key",      q: 'filename:terraform.tfvars "private_key" OR "mnemonic" NOT example' },
  { label: "Terraform env private key",  q: 'extension:tf "private_key" NOT variable NOT example NOT test' },

  // ── Jupyter Notebooks (data science / quant) ──────────────────────────────
  { label: "Jupyter private key",        q: 'extension:ipynb "private_key" OR "PRIVATE_KEY" NOT example NOT test' },
  { label: "Jupyter mnemonic",           q: 'extension:ipynb "mnemonic" NOT example NOT test' },
];

export interface AutoScanFinding {
  ts: number;
  severity: string;
  repo: string;
  path: string;
  fileUrl: string;
  query: string;
  queryLabel: string;
  valuePreview: string;
  confidence: number;
}

// ── Scan history (for trend chart, max 50 entries) ────────────────────────────
interface ScanHistoryEntry { ts: number; critical: number; high: number; total: number; }
const scanHistory: ScanHistoryEntry[] = [];

// ── SSE clients (live refresh) ────────────────────────────────────────────────
const sseClients = new Set<import("express").Response>();

function notifySseClients(event: string, data: unknown): void {
  if (!sseClients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

const autoScanState = {
  enabled: true,
  running: false,
  lastScan: null as number | null,
  nextScan: null as number | null,
  scanCount: 0,
  recentFindings: [] as AutoScanFinding[],
  totalNewFindings: 0,
  lastError: null as string | null,
  strictMode: false,
  queryHits: {} as Record<string, number>,
  // mid-scan token rotation stats (reset each scan)
  tokenSwitches: 0,
  queriesCompleted: 0,
  queriesSkipped: 0,
};

// Real-time scan progress (for progress bar in Dashboard)
const scanProgress = { total: 0, completed: 0, percent: 0 };

// Tracks finding keys (url|contenthash) — cleared every 7 days so updated files
// with new credentials are re-detected even if the URL was seen before.
const seenFindings = new Set<string>();
let seenFindingsCreatedAt = Date.now();
const SEEN_FINDINGS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Dedup LOW/MEDIUM (url → expiry ms, 24h TTL) ───────────────────────────────
const seenLowMedium = new Map<string, number>();
const SEEN_LOW_TTL_MS = 24 * 60 * 60 * 1000;

// ── Per-query stats: skip-quiet + incremental window ─────────────────────────
interface QueryStat { consecZero: number; skipUntil: number; lastHitAt: number | null; }
const queryStats = new Map<string, QueryStat>();

// ── Adaptive interval bounds ──────────────────────────────────────────────────
const MIN_SCAN_INTERVAL_MS = 15 * 60 * 1000;
const MAX_SCAN_INTERVAL_MS = 360 * 60 * 1000;
let consecutiveEmptyScans = 0;

function maybeClearSeenFindings(): void {
  if (Date.now() - seenFindingsCreatedAt > SEEN_FINDINGS_TTL_MS) {
    const prev = seenFindings.size;
    seenFindings.clear();
    seenFindingsCreatedAt = Date.now();
    saveFindings();
    logger.info({ cleared: prev }, "seenFindings reset after 7 days");
  }
}

// ── Persistence: findings survive server restarts ─────────────────────────────
interface PersistedState {
  recentFindings: AutoScanFinding[];
  seenKeys: string[];
  seenCreatedAt: number;
}

function loadPersistedFindings(): void {
  try {
    ensureDataDir();
    const raw = fs.readFileSync(FINDINGS_FILE, "utf-8");
    const saved = JSON.parse(raw) as PersistedState;
    autoScanState.recentFindings = saved.recentFindings ?? [];
    if (Date.now() - (saved.seenCreatedAt ?? 0) < SEEN_FINDINGS_TTL_MS) {
      for (const k of saved.seenKeys ?? []) seenFindings.add(k);
      seenFindingsCreatedAt = saved.seenCreatedAt ?? Date.now();
    }
    logger.info({ findings: autoScanState.recentFindings.length, seenKeys: seenFindings.size }, "Persisted findings loaded");
  } catch { /* no saved state yet — start fresh */ }
}

function saveFindings(): void {
  try {
    ensureDataDir();
    const state: PersistedState = {
      recentFindings: autoScanState.recentFindings,
      seenKeys: [...seenFindings],
      seenCreatedAt: seenFindingsCreatedAt,
    };
    fs.writeFileSync(FINDINGS_FILE, JSON.stringify(state));
  } catch (err) { logger.warn({ err }, "Failed to save findings to disk"); }
}

// ── Custom queries (file-backed, survives restarts) ────────────────────────────
let customQueries: Array<{ label: string; q: string }> = [];

function loadCustomQueries(): void {
  try {
    ensureDataDir();
    const raw = fs.readFileSync(CUSTOM_QUERIES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Array<{ label: string; q: string }>;
    customQueries = Array.isArray(parsed) ? parsed : [];
    if (customQueries.length) logger.info({ count: customQueries.length }, "Custom queries loaded");
  } catch { customQueries = []; }
}

function saveCustomQueries(): void {
  try {
    ensureDataDir();
    fs.writeFileSync(CUSTOM_QUERIES_FILE, JSON.stringify(customQueries, null, 2));
  } catch (err) { logger.warn({ err }, "Failed to save custom queries"); }
}

// ── Repo blocklist (file-backed, survives restarts) ────────────────────────────
let blocklist: string[] = [];

function loadBlocklist(): void {
  try {
    ensureDataDir();
    const raw = fs.readFileSync(BLOCKLIST_FILE, "utf-8");
    const parsed = JSON.parse(raw) as string[];
    blocklist = Array.isArray(parsed) ? parsed : [];
    if (blocklist.length) logger.info({ count: blocklist.length }, "Blocklist loaded");
  } catch { blocklist = []; }
}

function saveBlocklist(): void {
  try {
    ensureDataDir();
    fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(blocklist, null, 2));
  } catch (err) { logger.warn({ err }, "Failed to save blocklist"); }
}

loadBlocklist();

function getAllQueries(): Array<{ label: string; q: string }> {
  return [...AUTO_SCAN_QUERIES, ...customQueries];
}

/** Priority 0 = CRITICAL (run first), 1 = HIGH, 2 = normal. */
function queryPriority(label: string): number {
  const lo = label.toLowerCase();
  if (lo.includes("mnemonic") || lo.includes("seed phrase") || lo.includes("private key") ||
      lo.includes("privatekey") || lo.includes("keystore") || lo.includes("keypair") ||
      lo.includes("seed_phrase")) return 0;
  if (lo.includes("api key") || lo.includes("api_key") || lo.includes("secret") ||
      lo.includes("password") || lo.includes("token")) return 1;
  return 2;
}

/** Per-query incremental window: scan from last hit date (min 3d, max 30d). */
function queryWindowDays(label: string): number {
  const stats = queryStats.get(label);
  if (stats?.lastHitAt) {
    const daysSince = Math.ceil((Date.now() - stats.lastHitAt) / (24 * 60 * 60 * 1000));
    return Math.max(3, Math.min(daysSince + 1, 30));
  }
  return currentScanWindowDays;
}

loadCustomQueries();

let scanTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Wait until the token pool has at least one token available.
 * If the pool is exhausted, sleeps until the earliest reset window.
 * Returns false if we timed out waiting (shouldn't normally happen).
 */
async function waitForAvailableToken(timeoutMs = 70 * 60 * 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pick = tokenPool.pick();
    if (pick) return true;

    const earliest = tokenPool.earliestReset();
    if (!earliest) {
      // All tokens are dead (auth errors) — nothing to wait for
      logger.error("All tokens are invalid (auth errors). Auto-scan aborted.");
      return false;
    }

    const waitMs = Math.max(earliest - Date.now() + 5000, 5000); // 5s buffer after reset
    const waitSec = Math.round(waitMs / 1000);
    logger.warn(
      { waitSec, resetAt: new Date(earliest).toISOString() },
      `Auto-scan: all tokens exhausted — waiting ${waitSec}s for reset`
    );

    // Sleep in 30-second chunks so we don't over-sleep
    const chunk = Math.min(waitMs, 30_000);
    await new Promise<void>((r) => setTimeout(r, chunk));
  }

  return false; // timed out
}

async function runAutoScan(): Promise<void> {
  if (autoScanState.running) return;
  tokenPool.sync();
  if (!tokenPool.size) {
    logger.warn("Auto-scan skipped: no GitHub tokens configured");
    return;
  }

  maybeClearSeenFindings();
  autoScanState.running = true;
  autoScanState.lastError = null;
  autoScanState.tokenSwitches = 0;
  autoScanState.queriesCompleted = 0;
  autoScanState.queriesSkipped = 0;
  autoScanState.lastScan = Date.now();
  autoScanState.scanCount++;

  // ── #3 Priority queue: sort by priority (0=CRITICAL first) ───────────────
  const allQueries = getAllQueries().sort((a, b) => queryPriority(a.label) - queryPriority(b.label));

  // ── #2 Skip quiet queries: filter those with active cooldown ─────────────
  const now = Date.now();
  const activeQueries: Array<{ label: string; q: string }> = [];
  let cooldownCount = 0;
  for (const qry of allQueries) {
    const stats = queryStats.get(qry.label);
    if (stats && stats.skipUntil > now) {
      autoScanState.queriesSkipped++;
      cooldownCount++;
    } else {
      activeQueries.push(qry);
    }
  }

  logger.info(
    { scanCount: autoScanState.scanCount, active: activeQueries.length, cooldown: cooldownCount, tokens: tokenPool.size },
    "Auto-scan started"
  );

  // Initialize real-time progress tracking
  scanProgress.total = activeQueries.length;
  scanProgress.completed = 0;
  scanProgress.percent = 0;
  notifySseClients("scan-progress", { completed: 0, total: scanProgress.total, percent: 0, running: true });

  const newFindings: AutoScanFinding[] = [];
  const queryHitsThisScan: Record<string, number> = {};

  // ── Shared query queue (JS single-threaded: index++ is atomic) ───────────
  let queueIndex = 0;
  const tokensInUse = new Set<string>();

  interface GHItem {
    path: string; html_url: string;
    repository: { full_name: string };
    text_matches?: Array<{ fragment: string }>;
  }

  // ── #6 seenLowMedium cleanup (probabilistic 10%) ─────────────────────────
  if (Math.random() < 0.1) {
    const expireNow = Date.now();
    for (const [url, expiry] of seenLowMedium) { if (expiry < expireNow) seenLowMedium.delete(url); }
  }

  const processPage = (items: GHItem[], label: string, q: string) => {
    for (const item of items) {
      if (blocklist.includes(item.repository.full_name)) continue;

      const snippet = item.text_matches?.[0]?.fragment ?? "";
      const key = findingKey(item.html_url, snippet);
      if (seenFindings.has(key)) continue;

      // ── #6 Dedup LOW/MEDIUM by URL (24h TTL) — skip severity() call ──────
      const lowExpiry = seenLowMedium.get(item.html_url);
      if (lowExpiry && lowExpiry > Date.now()) continue;

      const sev = severity(item.path, snippet);
      if (sev !== "CRITICAL" && sev !== "HIGH") {
        seenLowMedium.set(item.html_url, Date.now() + SEEN_LOW_TTL_MS);
        continue;
      }
      seenFindings.add(key);

      if (autoScanState.strictMode) {
        if (sev !== "CRITICAL") continue;
        if (!CRITICAL_REGEXES.some(re => re.test(item.path + " " + snippet))) continue;
      }

      const finding: AutoScanFinding = {
        ts: Date.now(), severity: sev,
        repo: item.repository.full_name, path: item.path,
        fileUrl: item.html_url, query: q, queryLabel: label,
        valuePreview: extractValuePreview(snippet, item.path),
        confidence: confidenceScore(item.path, snippet, sev),
      };
      newFindings.push(finding);
      autoScanState.recentFindings.unshift(finding);
      autoScanState.queryHits[label] = (autoScanState.queryHits[label] ?? 0) + 1;
      queryHitsThisScan[label] = (queryHitsThisScan[label] ?? 0) + 1;
    }
  };

  // ── #1 Parallel worker — each worker pulls from the shared queue ──────────
  const runWorker = async (): Promise<void> => {
    while (true) {
      if (queueIndex >= activeQueries.length) break;
      const { label, q } = activeQueries[queueIndex++];

      await new Promise<void>((r) => setTimeout(r, queryDelayMs()));

      // Wait for a non-in-use token (spin 500ms; give up after 70 min)
      const workerDeadline = Date.now() + 70 * 60 * 1000;
      let picked: { token: string; state: TokenState } | null = null;
      while (Date.now() < workerDeadline) {
        if (tokenPool.pickExcluding(new Set()) === null) {
          logger.error("Auto-scan: all tokens dead, worker aborting");
          autoScanState.queriesSkipped++;
          return;
        }
        picked = tokenPool.pickExcluding(tokensInUse);
        if (picked) break;
        // All live tokens are in use by other workers — wait briefly
        await new Promise<void>((r) => setTimeout(r, 500));
      }
      if (!picked) { autoScanState.queriesSkipped++; break; }

      const { token, state } = picked;
      tokensInUse.add(token);

      try {
        // ── #4 Incremental window: per-query date based on last hit ──────────
        const windowDays = queryWindowDays(label);
        // Note: pushed: and fork: qualifiers are NOT valid in code search (/search/code)
        // and will cause 422 errors. The query is used as-is; client-side filterRecentRepos
        // handles age filtering on the returned items.
        const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=30&page=1&sort=indexed&order=desc`;
        const headers: Record<string, string> = {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.text-match+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "GH-Dork/2.0",
        };

        const r = await fetch(url, { headers });
        const remaining = parseInt(r.headers.get("x-ratelimit-remaining") ?? "-1", 10);
        const resetSec = r.headers.get("x-ratelimit-reset") ? parseInt(r.headers.get("x-ratelimit-reset")!, 10) : null;
        if (remaining >= 0) {
          tokenPool.update(token, remaining, resetSec);
          if (remaining < 5) logger.warn({ remaining, token: `...${token.slice(-4)}`, label }, "Auto-scan: token nearly exhausted");
        }

        if (r.status === 401) {
          tokenPool.flagError(token); tokenPool.update(token, 0, resetSec);
          logger.warn({ status: r.status, token: `...${token.slice(-4)}`, label }, "Auto-scan: token auth error");
          autoScanState.queriesSkipped++; continue;
        }
        if (r.status === 403 || r.status === 429) {
          // Rate limit hit — not an auth error; mark exhausted and wait for reset
          tokenPool.update(token, 0, resetSec);
          const retryAfter = r.headers.get("retry-after");
          logger.warn({ status: r.status, token: `...${token.slice(-4)}`, label, resetSec, retryAfter }, "Auto-scan: token rate limited");
          autoScanState.queriesSkipped++; continue;
        }
        if (r.status === 422) {
          // Invalid query syntax — log body for debugging and skip
          const errBody = await r.text().catch(() => "");
          logger.warn({ q, body: errBody.slice(0, 200) }, "Auto-scan: invalid query (422), skipping");
          autoScanState.queriesSkipped++; continue;
        }
        if (!r.ok) {
          logger.warn({ status: r.status, q }, "Auto-scan non-OK");
          autoScanState.queriesSkipped++; continue;
        }

        const data = (await r.json()) as { items: GHItem[] };
        autoScanState.queriesCompleted++;
        scanProgress.completed = autoScanState.queriesCompleted + autoScanState.queriesSkipped;
        if (scanProgress.total > 0) {
          scanProgress.percent = Math.min(100, Math.round((scanProgress.completed / scanProgress.total) * 100));
          notifySseClients("scan-progress", { completed: scanProgress.completed, total: scanProgress.total, percent: scanProgress.percent, running: true });
        }
        logger.info({ label, results: data.items?.length ?? 0, remaining: state.remaining, windowDays, token: `...${token.slice(-4)}` }, "Auto-scan query done");

        processPage(data.items ?? [], label, q);

        if ((data.items?.length ?? 0) >= 30 && state.remaining > 5) {
          try {
            const r2 = await fetch(url.replace("page=1", "page=2"), { headers });
            const rem2 = parseInt(r2.headers.get("x-ratelimit-remaining") ?? "-1", 10);
            const rst2 = r2.headers.get("x-ratelimit-reset");
            if (rem2 >= 0) tokenPool.update(token, rem2, rst2 ? parseInt(rst2, 10) : null);
            if (r2.ok) {
              const data2 = (await r2.json()) as { items: GHItem[] };
              processPage(data2.items ?? [], label, q);
              logger.info({ label, p2: data2.items?.length ?? 0 }, "Auto-scan page 2 fetched");
            }
          } catch (p2err) { logger.warn({ err: p2err, q }, "Auto-scan page 2 error (non-fatal)"); }
        }
      } catch (err) {
        logger.warn({ err, q }, "Auto-scan query error");
        autoScanState.queriesSkipped++;
      } finally {
        tokensInUse.delete(token);
      }
    }
  };

  // ── #1 Launch N parallel workers (one per token, max 5) ──────────────────
  const workerCount = Math.min(Math.max(1, tokenPool.size), 5);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  // ── #2 Update per-query stats (skip-quiet + incremental window) ───────────
  for (const { label } of allQueries) {
    const hits = queryHitsThisScan[label] ?? 0;
    const prev = queryStats.get(label) ?? { consecZero: 0, skipUntil: 0, lastHitAt: null };
    if (hits > 0) {
      queryStats.set(label, { consecZero: 0, skipUntil: 0, lastHitAt: Date.now() });
    } else if (activeQueries.some(a => a.label === label)) {
      const consecZero = prev.consecZero + 1;
      const skipUntil = consecZero >= 3 ? Date.now() + consecZero * currentScanIntervalMs : 0;
      queryStats.set(label, { ...prev, consecZero, skipUntil });
      if (skipUntil > 0) logger.info({ label, consecZero, skipMin: Math.round(consecZero * currentScanIntervalMs / 60000) }, "Query in cooldown");
    }
  }

  autoScanState.recentFindings = autoScanState.recentFindings.slice(0, 100);
  autoScanState.totalNewFindings += newFindings.length;
  autoScanState.running = false;
  saveFindings();

  // ── Scan history for trend chart ─────────────────────────────────────────
  const critical = newFindings.filter(f => f.severity === "CRITICAL").length;
  const high = newFindings.filter(f => f.severity === "HIGH").length;
  scanHistory.push({ ts: Date.now(), critical, high, total: newFindings.length });
  if (scanHistory.length > 50) scanHistory.shift();

  // ── Notify SSE clients ────────────────────────────────────────────────────
  if (newFindings.length > 0) notifySseClients("findings", { count: newFindings.length, critical, high, findings: newFindings.slice(0, 10) });
  notifySseClients("scan-complete", { ts: Date.now(), newFindings: newFindings.length });

  // ── #5 Adaptive interval ──────────────────────────────────────────────────
  const prevIntervalMs = currentScanIntervalMs;
  if (newFindings.length >= 5) {
    consecutiveEmptyScans = 0;
    currentScanIntervalMs = Math.max(MIN_SCAN_INTERVAL_MS, Math.round(currentScanIntervalMs * 0.75));
  } else if (newFindings.length === 0) {
    consecutiveEmptyScans++;
    if (consecutiveEmptyScans >= 2)
      currentScanIntervalMs = Math.min(MAX_SCAN_INTERVAL_MS, Math.round(currentScanIntervalMs * 1.5));
  } else {
    consecutiveEmptyScans = 0;
  }
  if (currentScanIntervalMs !== prevIntervalMs) {
    logger.info({ prevMs: prevIntervalMs, newMs: currentScanIntervalMs, newFindings: newFindings.length }, "Adaptive: interval adjusted");
    startScanTimer();
  } else {
    autoScanState.nextScan = Date.now() + currentScanIntervalMs;
  }

  logger.info(
    { newFindings: newFindings.length, totalSeen: seenFindings.size, queriesCompleted: autoScanState.queriesCompleted, queriesSkipped: autoScanState.queriesSkipped, intervalMs: currentScanIntervalMs, workers: workerCount },
    "Auto-scan completed"
  );

  if (newFindings.length > 0) void sendAutoScanTelegram(newFindings);
}

async function sendAutoScanTelegram(findings: AutoScanFinding[]): Promise<void> {
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!botToken || !chatId) return;

  const critical = findings.filter((f) => f.severity === "CRITICAL");
  const high = findings.filter((f) => f.severity === "HIGH");

  const header = [
    `🤖 <b>GH Dork — Auto-Scan Alert</b>`,
    ``,
    `⏰ Scan otomatis menemukan eksposur baru!`,
    ``,
    critical.length ? `💀 <b>CRITICAL:</b> ${critical.length} temuan baru` : null,
    high.length ? `🟠 <b>HIGH:</b> ${high.length} temuan baru` : null,
    ``,
  ].filter((l) => l !== null).join("\n");

  const top = [...critical, ...high].slice(0, 5);
  const body = top.map((f, i) =>
    `${i + 1}. ${f.severity === "CRITICAL" ? "🔴" : "🟠"} <b>${escHtml(f.repo)}</b>\n` +
    `   📄 <code>${escHtml(f.path)}</code>\n` +
    `   🏷 <i>${escHtml(f.queryLabel)}</i>\n` +
    `   🔗 ${escHtml(f.fileUrl)}`
  ).join("\n\n");

  const footer = findings.length > 5 ? `\n\n<i>...dan ${findings.length - 5} temuan lainnya</i>` : "";

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: header + body + footer,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) logger.warn({ status: res.status }, "Auto-scan Telegram failed");
    else logger.info({ count: findings.length }, "Auto-scan Telegram sent");
  } catch (err) {
    logger.warn({ err }, "Auto-scan Telegram error");
  }

  // Discord & Slack (plain text)
  const plainLines = [
    `🤖 GH Dork — Auto-Scan Alert`,
    `⏰ Scan otomatis menemukan eksposur baru!`,
    critical.length ? `💀 CRITICAL: ${critical.length} temuan baru` : null,
    high.length ? `🟠 HIGH: ${high.length} temuan baru` : null,
    ...top.map((f, i) =>
      `${i + 1}. ${f.severity === "CRITICAL" ? "🔴" : "🟠"} ${f.repo} / ${f.path}\n   🏷 ${f.queryLabel}\n   ${f.fileUrl}`
    ),
    findings.length > 5 ? `...dan ${findings.length - 5} temuan lainnya` : null,
  ].filter(Boolean).join("\n");
  void sendDiscord(plainLines);
  void sendSlack(plainLines);
}

function startScanTimer(): void {
  if (scanTimer) clearInterval(scanTimer);
  autoScanState.nextScan = Date.now() + currentScanIntervalMs;
  scanTimer = setInterval(() => { void runAutoScan(); }, currentScanIntervalMs);
  logger.info({ intervalMs: currentScanIntervalMs, minutes: currentScanIntervalMs / 60000 }, "Auto-scan timer started");
}

function stopScanTimer(): void {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  autoScanState.nextScan = null;
  logger.info("Auto-scan timer stopped");
}

// Load persisted state then start the timer
loadPersistedFindings();
startScanTimer();

// ── GET /api/github/config ────────────────────────────────────────────────────
router.get("/github/config", (_req, res) => {
  tokenPool.sync();
  res.json({
    tokensConfigured: tokenPool.size,
    tokens: tokenPool.summary(),
    telegramConfigured: !!(process.env["TELEGRAM_BOT_TOKEN"] && process.env["TELEGRAM_CHAT_ID"]),
    discordConfigured: !!process.env["DISCORD_WEBHOOK_URL"],
    slackConfigured: !!process.env["SLACK_WEBHOOK_URL"],
  });
});

// ── GET /api/github/rate-limit ────────────────────────────────────────────────
router.get("/github/rate-limit", async (req, res) => {
  const picked = tokenPool.pick();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "GH-Dork/2.0",
  };
  if (picked) headers["Authorization"] = `token ${picked.token}`;

  try {
    const r = await fetch("https://api.github.com/rate_limit", { headers });
    if (picked) {
      const remaining = parseInt(r.headers.get("x-ratelimit-remaining") ?? "-1", 10);
      const resetEpoch = r.headers.get("x-ratelimit-reset");
      if (remaining >= 0) tokenPool.update(picked.token, remaining, resetEpoch ? parseInt(resetEpoch, 10) : null);
    }
    const data = (await r.json()) as Record<string, unknown>;
    res.json({ ...data, tokenPool: tokenPool.summary() });
  } catch (err) {
    req.log.error({ err }, "rate-limit fetch failed");
    res.status(502).json({ error: "GitHub unreachable" });
  }
});

// ── GET /api/github/search ────────────────────────────────────────────────────
router.get("/github/search", async (req, res) => {
  const q = req.query["q"] as string | undefined;
  const page = parseInt((req.query["page"] as string) ?? "1", 10) || 1;
  const perPage = Math.min(parseInt((req.query["per_page"] as string) ?? "30", 10) || 30, 100);
  const notify = (req.query["notify"] as string) !== "false";

  if (!q || !q.trim()) {
    res.status(400).json({ error: "Missing query parameter q" });
    return;
  }

  const clientIp =
    ((req.headers["x-forwarded-for"] as string | undefined) ?? "").split(",")[0].trim() ||
    (req.socket?.remoteAddress ?? "unknown");
  if (!checkRateLimit(clientIp)) {
    res.status(429).json({ error: "Rate limit exceeded. Max 10 requests/minute.", retryAfter: 60 });
    return;
  }

  const picked = tokenPool.pick();
  if (!picked) {
    const earliest = tokenPool.earliestReset();
    res.status(503).json({
      error: "No GitHub token available.",
      reason: tokenPool.size === 0
        ? "No tokens configured. Set GITHUB_TOKEN or TOKEN_1/TOKEN_2/... in Replit Secrets."
        : "All tokens are rate-limited.",
      resetsAt: earliest ? new Date(earliest).toISOString() : null,
    });
    return;
  }

  const { token } = picked;

  // Note: pushed: is a repository search qualifier — NOT valid in /search/code.
  // Sending it causes HTTP 422. Query is used as-is.
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}&sort=indexed&order=desc`;
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.text-match+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "GH-Dork/2.0",
  };

  try {
    const r = await fetch(url, { headers });

    const remaining = parseInt(r.headers.get("x-ratelimit-remaining") ?? "-1", 10);
    const resetEpoch = r.headers.get("x-ratelimit-reset");
    const resetSec = resetEpoch ? parseInt(resetEpoch, 10) : null;
    if (remaining >= 0) tokenPool.update(token, remaining, resetSec);

    if (r.status === 401) {
      tokenPool.flagError(token);
      tokenPool.update(token, 0, resetSec);
      res.status(401).json({ error: "GitHub token invalid or expired. Check your secrets." });
      return;
    }
    if (r.status === 403) {
      tokenPool.update(token, 0, resetSec);
      const resetTime = resetSec
        ? new Date(resetSec * 1000).toISOString()
        : "unknown";
      res.status(429).json({ error: `Rate limit exceeded. Resets at ${resetTime}.` });
      return;
    }
    if (r.status === 422) {
      const body = (await r.json()) as { message?: string };
      res.status(422).json({ error: body.message ?? "Query validation failed." });
      return;
    }
    if (!r.ok) {
      res.status(r.status).json({ error: `GitHub API error: ${r.status}` });
      return;
    }

    interface GitHubSearchResponse {
      total_count: number;
      incomplete_results: boolean;
      items: Array<{
        name: string;
        path: string;
        html_url: string;
        repository: { full_name: string; html_url: string; stargazers_count: number; pushed_at: string; updated_at: string; fork: boolean; archived: boolean };
        text_matches?: Array<{ fragment: string }>;
      }>;
    }

    const data = (await r.json()) as GitHubSearchResponse;
    const enriched = data.items.map((item) => {
      const snippet = item.text_matches?.[0]?.fragment ?? "";
      const sev = severity(item.path, snippet);
      return { ...item, severity: sev, snippet, valuePreview: extractValuePreview(snippet, item.path), confidence: confidenceScore(item.path, snippet, sev) };
    });

    if (notify) {
      // Only notify for repos that were pushed in the last 30 days — skip old stale findings
      const freshCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const hits: Finding[] = enriched
        .filter((i) => {
          if (i.severity !== "CRITICAL" && i.severity !== "HIGH") return false;
          const repoDate = new Date(i.repository.updated_at ?? 0).getTime();
          return repoDate >= freshCutoff;
        })
        .map((i) => ({
          severity: i.severity,
          repo: i.repository.full_name,
          path: i.path,
          fileUrl: i.html_url,
          snippet: i.snippet,
        }));
      if (hits.length > 0) void sendTelegram(finalQuery, hits);
    }

    res.json({ ...data, items: enriched });
  } catch (err) {
    req.log.error({ err }, "GitHub search failed");
    res.status(502).json({ error: "Failed to reach GitHub API" });
  }
});

// ── POST /api/github/notify-test ──────────────────────────────────────────────
router.post("/github/notify-test", async (req, res) => {
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];

  if (!botToken || !chatId) {
    res.status(400).json({ error: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID not configured in Secrets." });
    return;
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text:
          "✅ <b>GH Dork</b> — Notifikasi Telegram berhasil dikonfigurasi!\n\n" +
          "Kamu akan menerima notifikasi ketika ditemukan data sensitif CRITICAL atau HIGH.",
        parse_mode: "HTML",
      }),
    });

    if (r.ok) {
      res.json({ ok: true, message: "Test notification sent to Telegram." });
    } else {
      const err = (await r.json()) as { description?: string };
      res.status(400).json({ error: err.description ?? "Telegram API error" });
    }
  } catch (err) {
    req.log.error({ err }, "Telegram test failed");
    res.status(502).json({ error: "Failed to reach Telegram API" });
  }
});

// ── GET /api/autoscan/status ──────────────────────────────────────────────────
router.get("/autoscan/status", (_req, res) => {
  res.json({
    enabled: autoScanState.enabled,
    running: autoScanState.running,
    strictMode: autoScanState.strictMode,
    lastScan: autoScanState.lastScan,
    nextScan: autoScanState.nextScan,
    scanCount: autoScanState.scanCount,
    totalNewFindings: autoScanState.totalNewFindings,
    recentFindings: autoScanState.recentFindings,
    queryHits: autoScanState.queryHits,
    windowDays: currentScanWindowDays,
    builtinQueriesCount: AUTO_SCAN_QUERIES.length,
    customQueriesCount: customQueries.length,
    customQueryList: customQueries,
    queriesCount: getAllQueries().length,
    queries: getAllQueries().map((q) => q.label),
    intervalMs: currentScanIntervalMs,
    consecutiveEmptyScans,
    queriesInCooldown: [...queryStats.values()].filter(s => s.skipUntil > Date.now()).length,
    // Token rotation stats from the most recent scan
    lastScanStats: {
      queriesCompleted: autoScanState.queriesCompleted,
      queriesSkipped: autoScanState.queriesSkipped,
      tokenSwitches: autoScanState.tokenSwitches,
    },
    tokenPool: tokenPool.summary(),
  });
});

// ── GET /api/autoscan/events (SSE live refresh) ───────────────────────────────
router.get("/autoscan/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  sseClients.add(res);
  const keepalive = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 25000);
  req.on("close", () => { sseClients.delete(res); clearInterval(keepalive); });
});

// ── GET /api/autoscan/history ─────────────────────────────────────────────────
router.get("/autoscan/history", (_req, res) => {
  res.json({ history: scanHistory });
});

// ── POST /api/autoscan/test-snippet ──────────────────────────────────────────
router.post("/autoscan/test-snippet", (req, res) => {
  const { snippet = "", filePath = "test.env" } = req.body as { snippet?: string; filePath?: string };
  if (!snippet) { res.status(400).json({ error: "snippet required" }); return; }
  const sev = severity(filePath, snippet);
  const vp = extractValuePreview(snippet, filePath);
  const conf = confidenceScore(filePath, snippet, sev);
  const placeholder = isPlaceholderValue(snippet);
  const testFile = isExampleOrTestFile(filePath);
  res.json({ severity: sev, valuePreview: vp, confidence: conf, isPlaceholder: placeholder, isTestFile: testFile });
});

// ── POST /api/autoscan/interval ───────────────────────────────────────────────
router.post("/autoscan/interval", (req, res) => {
  const minutes = parseInt(String(req.query["minutes"] ?? ""), 10);
  const allowed = [15, 30, 60, 120, 360];
  if (!Number.isFinite(minutes) || !allowed.includes(minutes)) {
    res.status(400).json({ error: `minutes must be one of: ${allowed.join(", ")}` });
    return;
  }
  currentScanIntervalMs = minutes * 60 * 1000;
  if (autoScanState.enabled) startScanTimer();
  logger.info({ intervalMs: currentScanIntervalMs, minutes }, "Auto-scan interval updated");
  res.json({ intervalMs: currentScanIntervalMs, minutes });
});

// ── POST /api/autoscan/window ─────────────────────────────────────────────────
router.post("/autoscan/window", (req, res) => {
  const days = parseInt(String(req.query["days"] ?? ""), 10);
  const allowed = [7, 14, 30];
  if (!Number.isFinite(days) || !allowed.includes(days)) {
    res.status(400).json({ error: `days must be one of: ${allowed.join(", ")}` });
    return;
  }
  currentScanWindowDays = days;
  logger.info({ days }, "Auto-scan window updated");
  res.json({ windowDays: currentScanWindowDays });
});

// ── GET /api/autoscan/custom-queries ─────────────────────────────────────────
router.get("/autoscan/custom-queries", (_req, res) => {
  res.json({ queries: customQueries });
});

// ── POST /api/autoscan/custom-queries ─────────────────────────────────────────
router.post("/autoscan/custom-queries", (req, res) => {
  const { label, q } = req.body as { label?: string; q?: string };
  if (!label?.trim() || !q?.trim()) {
    res.status(400).json({ error: "Both label and q are required" });
    return;
  }
  customQueries.push({ label: label.trim(), q: q.trim() });
  saveCustomQueries();
  logger.info({ label, q }, "Custom query added");
  res.status(201).json({ queries: customQueries });
});

// ── DELETE /api/autoscan/custom-queries/:index ────────────────────────────────
router.delete("/autoscan/custom-queries/:index", (req, res) => {
  const idx = parseInt(req.params["index"] ?? "", 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= customQueries.length) {
    res.status(400).json({ error: "Invalid index" });
    return;
  }
  const removed = customQueries.splice(idx, 1)[0];
  saveCustomQueries();
  logger.info({ removed }, "Custom query removed");
  res.json({ queries: customQueries });
});

// ── GET /api/autoscan/export ──────────────────────────────────────────────────
router.get("/autoscan/export", (req, res) => {
  const format = (req.query["format"] as string | undefined) ?? "json";
  const findings = autoScanState.recentFindings;

  if (format === "csv") {
    const header = "timestamp,severity,repo,path,query,queryLabel,fileUrl";
    const rows = findings.map((f) =>
      [
        new Date(f.ts).toISOString(),
        f.severity,
        `"${f.repo.replace(/"/g, '""')}"`,
        `"${f.path.replace(/"/g, '""')}"`,
        `"${f.query.replace(/"/g, '""')}"`,
        `"${f.queryLabel.replace(/"/g, '""')}"`,
        f.fileUrl,
      ].join(",")
    );
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="gh-dork-findings-${Date.now()}.csv"`);
    res.send([header, ...rows].join("\n"));
  } else {
    res.setHeader("Content-Disposition", `attachment; filename="gh-dork-findings-${Date.now()}.json"`);
    res.json(findings);
  }
});

// ── GET /api/autoscan/blocklist ───────────────────────────────────────────────
router.get("/autoscan/blocklist", (_req, res) => {
  res.json({ blocklist });
});

// ── POST /api/autoscan/blocklist ──────────────────────────────────────────────
router.post("/autoscan/blocklist", (req, res) => {
  const { repo } = req.body as { repo?: string };
  if (!repo?.trim()) {
    res.status(400).json({ error: "repo is required (e.g. owner/name)" });
    return;
  }
  const repoName = repo.trim();
  if (blocklist.includes(repoName)) {
    res.json({ blocklist });
    return;
  }
  blocklist.push(repoName);
  saveBlocklist();
  logger.info({ repo: repoName }, "Repo added to blocklist");
  res.status(201).json({ blocklist });
});

// ── DELETE /api/autoscan/blocklist/:index ─────────────────────────────────────
router.delete("/autoscan/blocklist/:index", (req, res) => {
  const idx = parseInt(req.params["index"] ?? "", 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= blocklist.length) {
    res.status(400).json({ error: "Invalid index" });
    return;
  }
  const removed = blocklist.splice(idx, 1)[0];
  saveBlocklist();
  logger.info({ removed }, "Repo removed from blocklist");
  res.json({ blocklist });
});

// ── POST /api/autoscan/strict ─────────────────────────────────────────────────
router.post("/autoscan/strict", (_req, res) => {
  autoScanState.strictMode = !autoScanState.strictMode;
  logger.info({ strictMode: autoScanState.strictMode }, "Auto-scan strict mode toggled");
  res.json({ strictMode: autoScanState.strictMode });
});

// ── POST /api/autoscan/toggle ─────────────────────────────────────────────────
router.post("/autoscan/toggle", (_req, res) => {
  autoScanState.enabled = !autoScanState.enabled;
  if (autoScanState.enabled) {
    startScanTimer();
  } else {
    stopScanTimer();
  }
  logger.info({ enabled: autoScanState.enabled }, "Auto-scan toggled");
  res.json({ enabled: autoScanState.enabled, nextScan: autoScanState.nextScan });
});

// ── POST /api/autoscan/run-now ────────────────────────────────────────────────
router.post("/autoscan/run-now", (req, res) => {
  if (autoScanState.running) {
    res.json({ ok: false, message: "Scan sudah berjalan." });
    return;
  }
  tokenPool.sync();
  if (!tokenPool.size) {
    res.status(503).json({ error: "No GitHub token configured." });
    return;
  }
  res.json({ ok: true, message: "Auto-scan dimulai sekarang." });
  void runAutoScan();
});

// ── Helper: derive category from query label ──────────────────────────────────
function deriveCategory(queryLabel: string): string {
  const l = queryLabel.toLowerCase();
  if (l.includes("mnemonic") || l.includes("seed") || l.includes("bip39") || l.includes("recovery")) return "Seed Phrase";
  if (l.includes("binance") || l.includes("coinbase") || l.includes("kraken") ||
      l.includes("bybit") || l.includes("okx") || l.includes("kucoin") ||
      l.includes("huobi") || l.includes("gate") || l.includes("bitget") || l.includes("mexc") ||
      l.includes("indodax") || l.includes("tokocrypto")) return "Exchange API";
  if (l.includes("infura") || l.includes("alchemy") || l.includes("quicknode") ||
      l.includes("moralis") || l.includes("helius") || l.includes("ankr") || l.includes("chainstack")) return "RPC Credential";
  if (l.includes("stripe") || l.includes("commerce") || l.includes("payment")) return "Payment Gateway";
  if (l.includes("solana") || l.includes("phantom") || l.includes("anchor") || l.includes("sol ")) return "Solana Key";
  if (l.includes("btc") || l.includes("bitcoin") || l.includes("wif") || l.includes("xprv")) return "Bitcoin Key";
  if (l.includes("tron") || l.includes("trx")) return "TRON Key";
  if (l.includes("hardhat") || l.includes("truffle") || l.includes("foundry") || l.includes("deploy")) return "Web3 Framework";
  if (l.includes("eth") || l.includes("evm") || l.includes("bsc") || l.includes("matic") ||
      l.includes("avax") || l.includes("deployer") || l.includes("signer")) return "ETH/EVM Key";
  if (l.includes("workflow") || l.includes("gitlab") || l.includes("circleci") || l.includes("jenkins") || l.includes("docker")) return "CI/CD";
  if (l.includes("keystore") || l.includes("wallet") || l.includes("utc--") || l.includes("vault")) return "Wallet File";
  if (l.includes("near") || l.includes("cosmos") || l.includes("polkadot") || l.includes("substrate")) return "Other Chain";
  if (l.includes("python") || l.includes("go ") || l.includes("rust") || l.includes("typescript") || l.includes("jupyter")) return "Lang Pattern";
  if (l.includes("ssh") || l.includes("rsa") || l.includes("openssh")) return "SSH Key";
  return "Other";
}

// ── GET /api/latest-results ───────────────────────────────────────────────────
router.get("/latest-results", (_req, res) => {
  const findings = autoScanState.recentFindings.slice(0, 100);

  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    const cat = deriveCategory(f.queryLabel);
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    const type = f.valuePreview ? f.valuePreview.split(":")[0].trim() : "Unknown";
    byType[type] = (byType[type] ?? 0) + 1;
  }

  res.json({
    findings,
    stats: {
      total: findings.length,
      totalAllTime: autoScanState.totalNewFindings,
      bySeverity,
      byCategory,
      byType,
      lastScan: autoScanState.lastScan,
      scanCount: autoScanState.scanCount,
      scanProgress: { ...scanProgress, running: autoScanState.running },
    },
  });
});

export default router;
