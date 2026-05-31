import { Router } from "express";
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
function severity(filePath: string, snippet: string): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const t = (filePath + " " + snippet).toLowerCase();
  if (
    t.includes("private_key") || t.includes("privatekey") ||
    t.includes("mnemonic") || t.includes("seed phrase") ||
    t.includes("keystore") || t.includes("ciphertext") ||
    t.includes("begin rsa") || t.includes("begin openssh") || t.includes("id_rsa") ||
    t.includes("recovery phrase")
  ) return "CRITICAL";
  if (
    t.includes("secret") || t.includes("api_secret") ||
    t.includes("password") || t.includes("jwt_secret") ||
    t.includes("sk_live") || (t.includes("api_key") && t.includes("binance")) ||
    t.includes("kraken") || t.includes("coinbase")
  ) return "HIGH";
  if (
    t.includes("api_key") || t.includes("token") || t.includes("infura") ||
    t.includes("alchemy") || t.includes("rpc_url") || t.includes("stripe") ||
    t.includes("moralis") || t.includes("quicknode")
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
}

// ── Auto-scan ─────────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const QUERY_DELAY_MS = 2000;             // polite pause between queries

const AUTO_SCAN_QUERIES: Array<{ label: string; q: string }> = [
  { label: "mnemonic .env",          q: 'filename:.env "MNEMONIC"' },
  { label: "PRIVATE_KEY .env",       q: 'filename:.env "PRIVATE_KEY"' },
  { label: "wallet.json keystore",   q: 'filename:wallet.json "crypto" "ciphertext"' },
  { label: "Trust Wallet mnemonic",  q: '"trustwallet" "mnemonic" extension:json' },
  { label: "Binance API key",        q: 'filename:.env "BINANCE_API_KEY"' },
  { label: "Coinbase API key",       q: 'filename:.env "COINBASE_API_KEY"' },
  { label: "Kraken key",             q: 'filename:.env "KRAKEN_API_KEY"' },
  { label: "Hardhat private key",    q: 'filename:hardhat.config.js "PRIVATE_KEY"' },
  { label: "deployer key",           q: '"DEPLOYER_PRIVATE_KEY" filename:.env' },
  { label: "OpenSSH Private Key",    q: '"BEGIN OPENSSH PRIVATE KEY"' },
  { label: "Ethereum keystore",      q: 'filename:keystore.json "version" "crypto" "ciphertext"' },
  { label: "Infura Project ID",      q: 'filename:.env "INFURA_PROJECT_ID"' },
  { label: "Alchemy API key",        q: 'filename:.env "ALCHEMY_API_KEY"' },
  { label: "OpenSea API key",        q: 'filename:.env "OPENSEA_API_KEY"' },
];

export interface AutoScanFinding {
  ts: number;
  severity: string;
  repo: string;
  path: string;
  fileUrl: string;
  query: string;
  queryLabel: string;
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
  // mid-scan token rotation stats (reset each scan)
  tokenSwitches: 0,
  queriesCompleted: 0,
  queriesSkipped: 0,
};

// Tracks file URLs we've already alerted on — survives for the life of the process
const seenFindings = new Set<string>();

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

  autoScanState.running = true;
  autoScanState.lastError = null;
  autoScanState.tokenSwitches = 0;
  autoScanState.queriesCompleted = 0;
  autoScanState.queriesSkipped = 0;
  const scanTs = Date.now();
  autoScanState.lastScan = scanTs;
  autoScanState.scanCount++;
  logger.info(
    { scanCount: autoScanState.scanCount, queries: AUTO_SCAN_QUERIES.length, tokens: tokenPool.size },
    "Auto-scan started"
  );

  const newFindings: AutoScanFinding[] = [];
  let prevToken: string | null = null;

  for (const { label, q } of AUTO_SCAN_QUERIES) {
    // Polite pause between queries
    await new Promise<void>((r) => setTimeout(r, QUERY_DELAY_MS));

    // Pick the best available token (may need to wait for a rate-limit reset)
    const available = await waitForAvailableToken();
    if (!available) {
      autoScanState.queriesSkipped++;
      logger.error("Auto-scan: giving up waiting for a token — scan aborted early");
      break;
    }

    const picked = tokenPool.pick();
    if (!picked) {
      autoScanState.queriesSkipped++;
      continue;
    }

    const { token, state } = picked;

    // Log token switches for observability
    if (prevToken && prevToken !== token) {
      autoScanState.tokenSwitches++;
      logger.info(
        { from: `...${prevToken.slice(-4)}`, to: `...${token.slice(-4)}`, label },
        "Auto-scan: switched token mid-scan"
      );
    }
    prevToken = token;

    try {
      const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=30&page=1`;
      const headers: Record<string, string> = {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.text-match+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "GH-Dork/2.0",
      };

      const r = await fetch(url, { headers });

      // Update this token's rate-limit state from response headers
      const remaining = parseInt(r.headers.get("x-ratelimit-remaining") ?? "-1", 10);
      const resetEpoch = r.headers.get("x-ratelimit-reset");
      const resetSec = resetEpoch ? parseInt(resetEpoch, 10) : null;

      if (remaining >= 0) {
        tokenPool.update(token, remaining, resetSec);
        if (remaining < 5) {
          logger.warn(
            { remaining, token: `...${token.slice(-4)}`, label },
            "Auto-scan: token nearly exhausted"
          );
        }
      }

      if (r.status === 401 || r.status === 403) {
        tokenPool.flagError(token);
        // Force remaining to 0 so this token isn't picked next
        tokenPool.update(token, 0, resetSec);
        logger.warn({ status: r.status, token: `...${token.slice(-4)}`, label }, "Auto-scan: token rejected, flagged");
        autoScanState.queriesSkipped++;
        continue;
      }

      if (!r.ok) {
        logger.warn({ status: r.status, q }, "Auto-scan query non-OK, skipping");
        autoScanState.queriesSkipped++;
        continue;
      }

      interface GHItem {
        path: string;
        html_url: string;
        repository: { full_name: string };
        text_matches?: Array<{ fragment: string }>;
      }
      const data = (await r.json()) as { items: GHItem[] };

      autoScanState.queriesCompleted++;
      logger.info(
        { label, results: data.items?.length ?? 0, remaining: state.remaining, token: `...${token.slice(-4)}` },
        "Auto-scan query done"
      );

      for (const item of data.items ?? []) {
        if (seenFindings.has(item.html_url)) continue;
        seenFindings.add(item.html_url);

        const snippet = item.text_matches?.[0]?.fragment ?? "";
        const sev = severity(item.path, snippet);
        if (sev !== "CRITICAL" && sev !== "HIGH") continue;

        const finding: AutoScanFinding = {
          ts: Date.now(),
          severity: sev,
          repo: item.repository.full_name,
          path: item.path,
          fileUrl: item.html_url,
          query: q,
          queryLabel: label,
        };
        newFindings.push(finding);
        autoScanState.recentFindings.unshift(finding);
      }
    } catch (err) {
      logger.warn({ err, q }, "Auto-scan query error");
      autoScanState.queriesSkipped++;
    }
  }

  // Keep only the last 100 findings in memory
  autoScanState.recentFindings = autoScanState.recentFindings.slice(0, 100);
  autoScanState.totalNewFindings += newFindings.length;
  autoScanState.running = false;
  autoScanState.nextScan = Date.now() + SCAN_INTERVAL_MS;

  logger.info(
    {
      newFindings: newFindings.length,
      totalSeen: seenFindings.size,
      queriesCompleted: autoScanState.queriesCompleted,
      queriesSkipped: autoScanState.queriesSkipped,
      tokenSwitches: autoScanState.tokenSwitches,
    },
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
}

function startScanTimer(): void {
  if (scanTimer) clearInterval(scanTimer);
  autoScanState.nextScan = Date.now() + SCAN_INTERVAL_MS;
  scanTimer = setInterval(() => { void runAutoScan(); }, SCAN_INTERVAL_MS);
  logger.info({ intervalMs: SCAN_INTERVAL_MS }, "Auto-scan timer started (1h interval)");
}

function stopScanTimer(): void {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  autoScanState.nextScan = null;
  logger.info("Auto-scan timer stopped");
}

// Start immediately when the module loads
startScanTimer();

// ── GET /api/github/config ────────────────────────────────────────────────────
router.get("/github/config", (_req, res) => {
  tokenPool.sync();
  res.json({
    tokensConfigured: tokenPool.size,
    tokens: tokenPool.summary(),
    telegramConfigured: !!(process.env["TELEGRAM_BOT_TOKEN"] && process.env["TELEGRAM_CHAT_ID"]),
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
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}`;
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
        repository: { full_name: string; html_url: string; stargazers_count: number; updated_at: string };
        text_matches?: Array<{ fragment: string }>;
      }>;
    }

    const data = (await r.json()) as GitHubSearchResponse;
    const enriched = data.items.map((item) => {
      const snippet = item.text_matches?.[0]?.fragment ?? "";
      return { ...item, severity: severity(item.path, snippet), snippet };
    });

    if (notify) {
      const hits: Finding[] = enriched
        .filter((i) => i.severity === "CRITICAL" || i.severity === "HIGH")
        .map((i) => ({
          severity: i.severity,
          repo: i.repository.full_name,
          path: i.path,
          fileUrl: i.html_url,
          snippet: i.snippet,
        }));
      if (hits.length > 0) void sendTelegram(q, hits);
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
    lastScan: autoScanState.lastScan,
    nextScan: autoScanState.nextScan,
    scanCount: autoScanState.scanCount,
    totalNewFindings: autoScanState.totalNewFindings,
    recentFindings: autoScanState.recentFindings,
    queriesCount: AUTO_SCAN_QUERIES.length,
    queries: AUTO_SCAN_QUERIES.map((q) => q.label),
    intervalMs: SCAN_INTERVAL_MS,
    // Token rotation stats from the most recent scan
    lastScanStats: {
      queriesCompleted: autoScanState.queriesCompleted,
      queriesSkipped: autoScanState.queriesSkipped,
      tokenSwitches: autoScanState.tokenSwitches,
    },
    tokenPool: tokenPool.summary(),
  });
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

export default router;
