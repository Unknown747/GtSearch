import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

// ── Token manager ────────────────────────────────────────────────────────────
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

// ── Severity classifier ──────────────────────────────────────────────────────
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
    t.includes("sk_live") || t.includes("api_key") && t.includes("binance") ||
    t.includes("kraken") || t.includes("coinbase")
  ) return "HIGH";
  if (
    t.includes("api_key") || t.includes("token") || t.includes("infura") ||
    t.includes("alchemy") || t.includes("rpc_url") || t.includes("stripe") ||
    t.includes("moralis") || t.includes("quicknode")
  ) return "MEDIUM";
  return "LOW";
}

// ── Telegram notifier ────────────────────────────────────────────────────────
interface Finding {
  severity: string;
  repo: string;
  path: string;
  fileUrl: string;
  snippet: string;
  category?: string;
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
  ]
    .filter((l) => l !== null)
    .join("\n");

  const topFindings = [...critical, ...high].slice(0, 5);
  const body = topFindings
    .map(
      (f, i) =>
        `${i + 1}. ${f.severity === "CRITICAL" ? "🔴" : "🟠"} <b>${f.repo}</b>\n` +
        `   📄 <code>${f.path}</code>\n` +
        `   🔗 ${f.fileUrl}`
    )
    .join("\n\n");

  const footer =
    findings.length > 5
      ? `\n\n<i>...dan ${findings.length - 5} temuan lainnya</i>`
      : "";

  const text = header + body + footer;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      logger.warn({ err }, "Telegram notification failed");
    } else {
      logger.info({ count: findings.length }, "Telegram notification sent");
    }
  } catch (err) {
    logger.warn({ err }, "Telegram notification error");
  }
}

// ── GET /api/github/config ───────────────────────────────────────────────────
router.get("/github/config", (_req, res) => {
  const tokens = getTokens();
  res.json({
    tokensConfigured: tokens.length,
    telegramConfigured: !!(
      process.env["TELEGRAM_BOT_TOKEN"] && process.env["TELEGRAM_CHAT_ID"]
    ),
  });
});

// ── GET /api/github/rate-limit ───────────────────────────────────────────────
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

// ── GET /api/github/search ───────────────────────────────────────────────────
router.get("/github/search", async (req, res) => {
  const q = req.query["q"] as string | undefined;
  const page = parseInt((req.query["page"] as string) ?? "1", 10) || 1;
  const perPage = Math.min(
    parseInt((req.query["per_page"] as string) ?? "30", 10) || 30,
    100
  );
  const notify = (req.query["notify"] as string) !== "false";

  if (!q || !q.trim()) {
    res.status(400).json({ error: "Missing query parameter q" });
    return;
  }

  const token = pickToken();
  if (!token) {
    res.status(503).json({
      error:
        "No GitHub token configured. Set GITHUB_TOKEN or TOKEN_1/TOKEN_2/... in Replit Secrets.",
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
        repository: {
          full_name: string;
          html_url: string;
          stargazers_count: number;
          updated_at: string;
        };
        text_matches?: Array<{ fragment: string }>;
      }>;
    }

    const data = (await r.json()) as GitHubSearchResponse;

    // Enrich with severity
    const enriched = data.items.map((item) => {
      const snippet = item.text_matches?.[0]?.fragment ?? "";
      return {
        ...item,
        severity: severity(item.path, snippet),
        snippet,
      };
    });

    // Telegram notification for CRITICAL/HIGH
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

      if (hits.length > 0) {
        void sendTelegram(q, hits);
      }
    }

    res.json({ ...data, items: enriched });
  } catch (err) {
    req.log.error({ err }, "GitHub search failed");
    res.status(502).json({ error: "Failed to reach GitHub API" });
  }
});

// ── POST /api/github/notify-test ─────────────────────────────────────────────
router.post("/github/notify-test", async (req, res) => {
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];

  if (!botToken || !chatId) {
    res.status(400).json({
      error: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID not configured in Secrets.",
    });
    return;
  }

  try {
    const r = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text:
            "✅ <b>GH Dork</b> — Notifikasi Telegram berhasil dikonfigurasi!\n\n" +
            "Kamu akan menerima notifikasi ketika ditemukan data sensitif CRITICAL atau HIGH.",
          parse_mode: "HTML",
        }),
      }
    );

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

export default router;
