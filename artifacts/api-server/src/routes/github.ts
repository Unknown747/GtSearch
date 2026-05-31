import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

// ── Token manager ─────────────────────────────────────────────────────────────
function getTokens(): string[] {
  const tokens: string[] = [];
  const single = process.env["GITHUB_TOKEN"];
  if (single) tokens.push(single);
  for (let i = 1; i <= 20; i++) {
    const t = process.env[`TOKEN_${i}`];
    if (t) tokens.push(t);
  }
  return [...new Set(tokens)];
}

let _tokenIndex = 0;
function pickToken(): string | null {
  const tokens = getTokens();
  if (!tokens.length) return null;
  return tokens[_tokenIndex % tokens.length];
}
function rotateToken(): void {
  _tokenIndex++;
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
    `🔍 Query: <code>${query.substring(0, 120)}</code>`,
    ``,
    critical.length ? `💀 <b>CRITICAL:</b> ${critical.length} temuan` : null,
    high.length ? `🟠 <b>HIGH:</b> ${high.length} temuan` : null,
    ``,
  ].filter((l) => l !== null).join("\n");

  const top = [...critical, ...high].slice(0, 5);
  const body = top.map((f, i) =>
    `${i + 1}. ${f.severity === "CRITICAL" ? "🔴" : "🟠"} <b>${f.repo}</b>\n` +
    `   📄 <code>${f.path}</code>\n` +
    `   🔗 ${f.fileUrl}`
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
};

// Tracks file URLs we've already alerted on — survives for the life of the process
const seenFindings = new Set<string>();

let scanTimer: ReturnType<typeof setInterval> | null = null;

async function runAutoScan(): Promise<void> {
  if (autoScanState.running) return;
  if (!getTokens().length) {
    logger.warn("Auto-scan skipped: no GitHub tokens configured");
    return;
  }

  autoScanState.running = true;
  autoScanState.lastError = null;
  const scanTs = Date.now();
  autoScanState.lastScan = scanTs;
  autoScanState.scanCount++;
  logger.info({ scanCount: autoScanState.scanCount, queries: AUTO_SCAN_QUERIES.length }, "Auto-scan started");

  const newFindings: AutoScanFinding[] = [];

  for (const { label, q } of AUTO_SCAN_QUERIES) {
    // Respect rate limits: 2-second pause between queries
    await new Promise<void>((r) => setTimeout(r, 2000));

    const token = pickToken();
    if (!token) break;

    try {
      const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=30&page=1`;
      const headers: Record<string, string> = {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.text-match+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "GH-Dork/2.0",
      };

      const r = await fetch(url, { headers });

      const remaining = parseInt(r.headers.get("x-ratelimit-remaining") ?? "999", 10);
      if (remaining < 5) {
        rotateToken();
        logger.warn({ remaining }, "Auto-scan: rate limit low, rotated token");
      }

      if (!r.ok) {
        if (r.status === 403 || r.status === 401) rotateToken();
        logger.warn({ status: r.status, q }, "Auto-scan query non-OK, skipping");
        continue;
      }

      interface GHItem {
        path: string;
        html_url: string;
        repository: { full_name: string };
        text_matches?: Array<{ fragment: string }>;
      }
      const data = (await r.json()) as { items: GHItem[] };

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
    }
  }

  // Keep only the last 100 findings in memory
  autoScanState.recentFindings = autoScanState.recentFindings.slice(0, 100);
  autoScanState.totalNewFindings += newFindings.length;
  autoScanState.running = false;
  autoScanState.nextScan = Date.now() + SCAN_INTERVAL_MS;

  logger.info(
    { newFindings: newFindings.length, totalSeen: seenFindings.size },
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
    `${i + 1}. ${f.severity === "CRITICAL" ? "🔴" : "🟠"} <b>${f.repo}</b>\n` +
    `   📄 <code>${f.path}</code>\n` +
    `   🏷 <i>${f.queryLabel}</i>\n` +
    `   🔗 ${f.fileUrl}`
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
  const tokens = getTokens();
  res.json({
    tokensConfigured: tokens.length,
    telegramConfigured: !!(process.env["TELEGRAM_BOT_TOKEN"] && process.env["TELEGRAM_CHAT_ID"]),
  });
});

// ── GET /api/github/rate-limit ────────────────────────────────────────────────
router.get("/github/rate-limit", async (req, res) => {
  const token = pickToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "GH-Dork/2.0",
  };
  if (token) headers["Authorization"] = `token ${token}`;

  try {
    const r = await fetch("https://api.github.com/rate_limit", { headers });
    const data = (await r.json()) as Record<string, unknown>;
    res.json(data);
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

  const token = pickToken();
  if (!token) {
    res.status(503).json({
      error: "No GitHub token configured. Set GITHUB_TOKEN or TOKEN_1/TOKEN_2/... in Replit Secrets.",
    });
    return;
  }

  const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}`;
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.text-match+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "GH-Dork/2.0",
  };

  try {
    const r = await fetch(url, { headers });

    const remaining = parseInt(r.headers.get("x-ratelimit-remaining") ?? "999", 10);
    if (remaining < 5) {
      rotateToken();
      req.log.warn({ remaining }, "Rate limit low, rotated token");
    }

    if (r.status === 401) {
      rotateToken();
      res.status(401).json({ error: "GitHub token invalid or expired. Check your secrets." });
      return;
    }
    if (r.status === 403) {
      const resetEpoch = r.headers.get("x-ratelimit-reset");
      const resetTime = resetEpoch
        ? new Date(parseInt(resetEpoch, 10) * 1000).toLocaleTimeString()
        : "unknown";
      rotateToken();
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
  if (!getTokens().length) {
    res.status(503).json({ error: "No GitHub token configured." });
    return;
  }
  res.json({ ok: true, message: "Auto-scan dimulai sekarang." });
  void runAutoScan();
});

export default router;
