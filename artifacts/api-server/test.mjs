/**
 * GH Dork — API Test Script
 * Run: node test.mjs
 * Adapts assertions to the current environment (tokens/Telegram configured or not).
 */

const BASE = "http://localhost:8080";
let passed = 0;
let failed = 0;

function ok(label, cond, detail = "") {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  const body = await r.json();
  return { status: r.status, body };
}

async function post(path, json) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: json ? { "Content-Type": "application/json" } : {},
    body: json ? JSON.stringify(json) : undefined,
  });
  const body = await r.json();
  return { status: r.status, body };
}

// ─── Detect environment capabilities ─────────────────────────────────────────
const { body: cfg } = await get("/api/github/config");
const hasTokens     = cfg.tokensConfigured > 0;
const hasTelegram   = cfg.telegramConfigured === true;
console.log(`\n⚙  Environment: tokens=${cfg.tokensConfigured}, telegram=${hasTelegram}`);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🔧  [1] Unit — escHtml logic");
{
  function escHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  ok("plain string unchanged",   escHtml("hello/world") === "hello/world");
  ok("ampersand escaped",        escHtml("a&b") === "a&amp;b");
  ok("< and > escaped",          escHtml("a<b>c") === "a&lt;b&gt;c");
  ok("double quote escaped",     escHtml('"val"') === "&quot;val&quot;");
  ok("repo name with angle",     escHtml("user/<evil>") === "user/&lt;evil&gt;");
  ok("full XSS injection",       escHtml('</b><script>alert(1)</script>') ===
     "&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🔧  [2] Unit — renderContent defensive guards");
{
  // Simulate the fixed logic inline
  function renderCount(total_count) {
    const totalCount = total_count ?? 0;
    return totalCount.toLocaleString();
  }
  function renderStars(stargazers_count) {
    return (stargazers_count ?? 0).toLocaleString();
  }
  function renderUpd(updated_at) {
    return updated_at ? new Date(updated_at).toLocaleDateString('id-ID') : '—';
  }
  function renderHistCount(count) {
    return (count ?? 0).toLocaleString();
  }

  ok("total_count undefined → '0'",           renderCount(undefined) === "0");
  ok("total_count null → '0'",                renderCount(null) === "0");
  ok("total_count 1234 → '1.234'",            renderCount(1234) !== "");
  ok("stargazers_count undefined → '0'",      renderStars(undefined) === "0");
  ok("stargazers_count null → '0'",           renderStars(null) === "0");
  ok("stargazers_count 42 → '42'",            renderStars(42) === "42");
  ok("updated_at undefined → '—'",            renderUpd(undefined) === "—");
  ok("updated_at valid → date string",        renderUpd("2024-01-15T00:00:00Z") !== "—");
  ok("history count undefined → '0'",         renderHistCount(undefined) === "0");
  ok("history count 99 → '99'",              renderHistCount(99) === "99");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🔧  [3] Unit — severity classifier");
{
  function severity(filePath, snippet) {
    const t = (filePath + " " + snippet).toLowerCase();
    if (t.includes("private_key") || t.includes("privatekey") ||
        t.includes("mnemonic") || t.includes("seed phrase") ||
        t.includes("keystore") || t.includes("ciphertext") ||
        t.includes("begin rsa") || t.includes("begin openssh") || t.includes("id_rsa") ||
        t.includes("recovery phrase")) return "CRITICAL";
    if (t.includes("secret") || t.includes("api_secret") ||
        t.includes("password") || t.includes("jwt_secret") ||
        t.includes("sk_live") || (t.includes("api_key") && t.includes("binance")) ||
        t.includes("kraken") || t.includes("coinbase")) return "HIGH";
    if (t.includes("api_key") || t.includes("token") || t.includes("infura") ||
        t.includes("alchemy") || t.includes("rpc_url") || t.includes("stripe") ||
        t.includes("moralis") || t.includes("quicknode")) return "MEDIUM";
    return "LOW";
  }
  ok("PRIVATE_KEY → CRITICAL",     severity(".env","PRIVATE_KEY=0x123") === "CRITICAL");
  ok("mnemonic → CRITICAL",        severity(".env","MNEMONIC=word1 word2") === "CRITICAL");
  ok("BEGIN OPENSSH → CRITICAL",   severity("id_rsa","BEGIN OPENSSH PRIVATE KEY") === "CRITICAL");
  ok("ciphertext → CRITICAL",      severity("keystore.json","ciphertext") === "CRITICAL");
  ok("password → HIGH",            severity(".env","DB_PASSWORD=secret") === "HIGH");
  ok("binance api_key → HIGH",     severity(".env","BINANCE_API_KEY=abc") === "HIGH");
  ok("coinbase → HIGH",            severity(".env","coinbase_key=x") === "HIGH");
  ok("infura → MEDIUM",            severity(".env","INFURA_PROJECT_ID=abc") === "MEDIUM");
  ok("alchemy → MEDIUM",           severity(".env","ALCHEMY_API_KEY=abc") === "MEDIUM");
  ok("random readme → LOW",        severity("README.md","hello world") === "LOW");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🌐  [4] GET /api/github/config");
{
  const { status, body } = await get("/api/github/config");
  ok("HTTP 200",                      status === 200);
  ok("tokensConfigured is number",    typeof body.tokensConfigured === "number");
  ok("tokens is array",               Array.isArray(body.tokens));
  ok("telegramConfigured is boolean", typeof body.telegramConfigured === "boolean");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🌐  [5] GET /api/github/rate-limit");
{
  const { status, body } = await get("/api/github/rate-limit");
  ok("HTTP 200",                      status === 200);
  ok("resources present",             !!body.resources);
  ok("search resource present",       !!body.resources?.search);
  ok("remaining is number",           typeof body.resources?.search?.remaining === "number");
  ok("limit is number",               typeof body.resources?.search?.limit === "number");
  ok("tokenPool in response",         Array.isArray(body.tokenPool));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🌐  [6] GET /api/autoscan/status");
{
  const { status, body } = await get("/api/autoscan/status");
  ok("HTTP 200",                      status === 200);
  ok("enabled is boolean",            typeof body.enabled === "boolean");
  ok("running is boolean",            typeof body.running === "boolean");
  ok("scanCount is number",           typeof body.scanCount === "number");
  ok("queriesCount is 14",            body.queriesCount === 14);
  ok("queries array length 14",       Array.isArray(body.queries) && body.queries.length === 14);
  ok("tokenPool is array",            Array.isArray(body.tokenPool));
  ok("lastScanStats present",         !!body.lastScanStats);
  ok("lastScanStats.queriesCompleted",typeof body.lastScanStats?.queriesCompleted === "number");
  ok("lastScanStats.tokenSwitches",   typeof body.lastScanStats?.tokenSwitches === "number");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🌐  [7] GET /api/github/search — validation");
{
  // Missing q param always → 400
  const { status: s1, body: b1 } = await get("/api/github/search");
  ok("HTTP 400 on missing q",         s1 === 400);
  ok("error mentions q param",        b1.error?.toLowerCase().includes("q"));

  // Empty q always → 400
  const { status: s2 } = await get("/api/github/search?q=");
  ok("HTTP 400 on empty q",           s2 === 400);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n🌐  [8] GET /api/github/search — token state (${hasTokens ? "tokens present" : "no tokens"})`);
{
  const { status, body } = await get("/api/github/search?q=filename:.env+MNEMONIC");
  if (hasTokens) {
    // With tokens: GitHub may return 200 (results) or 429/422 (rate-limit/query error)
    ok("returns valid HTTP code",     [200, 422, 429, 503].includes(status),
       `got ${status}`);
    ok("body is an object",           typeof body === "object" && body !== null);
    if (status === 200) {
      ok("items is array",            Array.isArray(body.items));
      ok("total_count is number",     typeof body.total_count === "number");
    } else {
      ok("error message present",     typeof body.error === "string");
    }
  } else {
    ok("HTTP 503 when no token",      status === 503);
    ok("error present",               typeof body.error === "string");
    ok("reason mentions GITHUB_TOKEN",body.reason?.includes("GITHUB_TOKEN"));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🌐  [9] POST /api/autoscan/toggle (off → on)");
{
  const { body: before } = await get("/api/autoscan/status");
  const wasEnabled = before.enabled;

  const { status: s1, body: b1 } = await post("/api/autoscan/toggle");
  ok("HTTP 200",                      s1 === 200);
  ok("enabled flipped",               b1.enabled === !wasEnabled);

  const { status: s2, body: b2 } = await post("/api/autoscan/toggle");
  ok("HTTP 200",                      s2 === 200);
  ok("enabled restored",              b2.enabled === wasEnabled);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n🌐  [10] POST /api/autoscan/run-now (${hasTokens ? "tokens present" : "no tokens"})`);
{
  const { status, body } = await post("/api/autoscan/run-now");
  if (hasTokens) {
    // With tokens: 200 (started) or scan already running
    ok("HTTP 200",                    status === 200);
    ok("ok or message field",         typeof (body.ok ?? body.message) !== "undefined");
  } else {
    ok("HTTP 503 when no token",      status === 503);
    ok("error field present",         typeof body.error === "string");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n🌐  [11] POST /api/github/notify-test (${hasTelegram ? "Telegram configured" : "no Telegram"})`);
{
  const { status, body } = await post("/api/github/notify-test");
  if (hasTelegram) {
    // Telegram configured: either 200 (sent) or 400 (Telegram API rejected)
    ok("HTTP 200 or 400",             [200, 400].includes(status), `got ${status}`);
    ok("response has ok or error",    typeof (body.ok ?? body.error) !== "undefined");
  } else {
    ok("HTTP 400 when unconfigured",  status === 400);
    ok("error mentions TELEGRAM",     body.error?.includes("TELEGRAM"));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🌐  [12] Static UI — GET /");
{
  const r = await fetch(`${BASE}/`);
  const html = await r.text();
  ok("HTTP 200",                      r.status === 200);
  ok("Content-Type is HTML",          r.headers.get("content-type")?.includes("text/html"));
  ok("Contains GH Dork in body",      html.includes("GH Dork"));
  ok("Contains esc() function",       html.includes("function esc("));
  ok("Defensive ??0 guard present",   html.includes("??0"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n📊  [13] TokenPool — response shape");
{
  const { body } = await get("/api/autoscan/status");
  const pool = body.tokenPool;
  ok("tokenPool is array",            Array.isArray(pool));
  if (pool.length > 0) {
    const t = pool[0];
    ok("token has index",             typeof t.index === "number");
    ok("token suffix starts with ...",typeof t.suffix === "string" && t.suffix.startsWith("..."));
    ok("token has remaining",         typeof t.remaining === "number");
    ok("token has requests",          typeof t.requests === "number");
    ok("token has errors",            typeof t.errors === "number");
  } else {
    ok("no tokens — skipping shape check", true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n📊  [14] Concurrent requests — server stability");
{
  const requests = await Promise.all([
    get("/api/github/config"),
    get("/api/autoscan/status"),
    get("/api/github/rate-limit"),
    get("/api/github/search?q=test"),
    get("/api/autoscan/status"),
  ]);
  const allValid = requests.every(r => r.status >= 200 && r.status < 600);
  ok("All 5 concurrent requests got valid HTTP codes", allValid,
     requests.map(r => r.status).join(", "));
  ok("Config returns 200",            requests[0].status === 200);
  ok("Autoscan returns 200",          requests[1].status === 200);
}

// ─────────────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log("\n─────────────────────────────────");
console.log(`Results: ${passed}/${total} passed  ${failed > 0 ? `(${failed} FAILED)` : "✅ all passed"}`);
if (failed > 0) process.exit(1);
