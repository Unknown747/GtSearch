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

function severity(filePath: string, snippet: string): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const raw = filePath + " " + snippet;
  const t = raw.toLowerCase();

  // ── CRITICAL: regex confirms actual key value present ──────────────────────
  for (const re of CRITICAL_REGEXES) { if (re.test(raw)) return "CRITICAL"; }

  // ── CRITICAL: keywords strongly indicating a plaintext crypto secret ───────
  if (
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
  ) return "CRITICAL";

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
}

// ── Auto-scan ─────────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
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
  { label: "mnemonic .env",              q: 'filename:.env "MNEMONIC"' },
  { label: "PRIVATE_KEY .env",           q: 'filename:.env "PRIVATE_KEY"' },
  { label: "seed phrase .env",           q: 'filename:.env "SEED_PHRASE" OR "SECRET_RECOVERY_PHRASE"' },
  { label: "Trust Wallet mnemonic",      q: '"trustwallet" "mnemonic" extension:json' },
  { label: "MetaMask seed words",        q: '"metamask" "seed" "words" extension:json' },
  { label: "seed phrase JS",             q: '"bip39" "mnemonic" "entropy" language:javascript' },
  { label: ".env.production key",        q: 'filename:.env.production "PRIVATE_KEY" OR "MNEMONIC"' },
  { label: ".env.local key",             q: 'filename:.env.local "PRIVATE_KEY" OR "MNEMONIC"' },

  // ── EVM Chains (ETH / BSC / AVAX / MATIC / ARB / OP) ────────────────────
  { label: "ETH private key .env",       q: 'filename:.env "ETH_PRIVATE_KEY" OR "ETHEREUM_PRIVATE_KEY"' },
  { label: "BSC private key",            q: 'filename:.env "BSC_PRIVATE_KEY" OR "BNB_PRIVATE_KEY"' },
  { label: "AVAX private key",           q: 'filename:.env "AVAX_PRIVATE_KEY" OR "AVALANCHE_PRIVATE_KEY"' },
  { label: "MATIC private key",          q: 'filename:.env "MATIC_PRIVATE_KEY" OR "POLYGON_PRIVATE_KEY"' },
  { label: "deployer key",               q: '"DEPLOYER_PRIVATE_KEY" filename:.env' },
  { label: "signer private key",         q: 'filename:.env "SIGNER_PRIVATE_KEY" OR "OPERATOR_PRIVATE_KEY"' },

  // ── Solana ────────────────────────────────────────────────────────────────
  { label: "Solana private key",         q: 'filename:.env "SOLANA_PRIVATE_KEY" OR "SOL_PRIVATE_KEY"' },
  { label: "Phantom wallet key",         q: 'filename:.env "PHANTOM_PRIVATE_KEY"' },
  { label: "Solana keypair.json",        q: 'filename:keypair.json extension:json language:json "[" NOT "test"' },
  { label: "Anchor wallet keypair",      q: 'filename:id.json path:.config/solana "[1," OR "[2,"' },

  // ── NEAR Protocol ─────────────────────────────────────────────────────────
  { label: "NEAR private key",           q: 'filename:.env "NEAR_PRIVATE_KEY" OR "NEAR_SECRET"' },
  { label: "NEAR credentials file",      q: 'filename:credentials.json "ed25519:" path:.near' },

  // ── Tron / TRX ───────────────────────────────────────────────────────────
  { label: "Tron private key",           q: 'filename:.env "TRON_PRIVATE_KEY" OR "TRX_PRIVATE_KEY"' },
  { label: "Tron key JS",                q: 'language:javascript "TronWeb" "privateKey"' },

  // ── Cosmos / Terra / Polkadot ─────────────────────────────────────────────
  { label: "Cosmos mnemonic",            q: 'filename:.env "COSMOS_MNEMONIC" OR "TERRA_MNEMONIC"' },
  { label: "Polkadot seed",              q: 'filename:.env "DOT_MNEMONIC" OR "POLKADOT_MNEMONIC" OR "SUBSTRATE_SEED"' },

  // ── Wallet files ─────────────────────────────────────────────────────────
  { label: "Ethereum keystore.json",     q: 'filename:keystore.json "version" "crypto" "ciphertext"' },
  { label: "UTC-- wallet file",          q: 'filename:UTC-- "ciphertext"' },
  { label: "wallet.json ciphertext",     q: 'filename:wallet.json "crypto" "ciphertext"' },
  { label: "MetaMask vault",             q: 'filename:vault.json "data" "iv" "salt"' },
  { label: "Exodus wallet backup",       q: 'filename:exodus.wallet.bak OR filename:exodus-backup' },
  { label: "BIP32 xprv key",            q: '"xprv" extension:json OR extension:txt OR extension:env' },

  // ── Exchange API Keys ─────────────────────────────────────────────────────
  { label: "Binance API key",            q: 'filename:.env "BINANCE_API_KEY"' },
  { label: "Coinbase API key",           q: 'filename:.env "COINBASE_API_KEY"' },
  { label: "Kraken API key",             q: 'filename:.env "KRAKEN_API_KEY"' },
  { label: "Bybit API key",              q: 'filename:.env "BYBIT_API_KEY"' },
  { label: "OKX API key",               q: 'filename:.env "OKX_API_KEY" OR "OKEX_API_KEY"' },
  { label: "KuCoin API key",             q: 'filename:.env "KUCOIN_API_KEY" OR "KUCOIN_KEY"' },
  { label: "Huobi / HTX API key",        q: 'filename:.env "HUOBI_API_KEY" OR "HTX_API_KEY"' },
  { label: "Gate.io API key",            q: 'filename:.env "GATE_API_KEY" OR "GATEIO_API_KEY"' },
  { label: "Bitget API key",             q: 'filename:.env "BITGET_API_KEY"' },
  { label: "MEXC API key",               q: 'filename:.env "MEXC_API_KEY"' },
  { label: "Indodax / Tokocrypto key",   q: 'filename:.env "INDODAX_API_KEY" OR "TOKOCRYPTO_API_KEY"' },

  // ── Smart contract / DeFi ────────────────────────────────────────────────
  { label: "Hardhat private key JS",     q: 'filename:hardhat.config.js "PRIVATE_KEY"' },
  { label: "Hardhat private key TS",     q: 'filename:hardhat.config.ts "PRIVATE_KEY" OR "mnemonic"' },
  { label: "Truffle mnemonic",           q: 'filename:truffle-config.js "mnemonic"' },
  { label: "Foundry private_key",        q: 'filename:foundry.toml "private_key"' },
  { label: "Anchor deploy key",          q: 'filename:Anchor.toml "wallet" path:.config/solana' },

  // ── RPC / Node Infrastructure ─────────────────────────────────────────────
  { label: "Infura Project ID",          q: 'filename:.env "INFURA_PROJECT_ID"' },
  { label: "Alchemy API key",            q: 'filename:.env "ALCHEMY_API_KEY"' },
  { label: "Helius API key (Solana)",    q: 'filename:.env "HELIUS_API_KEY"' },
  { label: "QuickNode token",            q: 'filename:.env "QUICKNODE_TOKEN" OR "QUICKNODE_API_KEY"' },
  { label: "Moralis API key",            q: 'filename:.env "MORALIS_API_KEY"' },
  { label: "Ankr API key",              q: 'filename:.env "ANKR_API_KEY"' },

  // ── NFT & IPFS ────────────────────────────────────────────────────────────
  { label: "Pinata IPFS key",            q: 'filename:.env "PINATA_API_KEY" "PINATA_SECRET"' },
  { label: "NFT Storage key",            q: 'filename:.env "NFT_STORAGE_API_KEY"' },
  { label: "OpenSea API key",            q: 'filename:.env "OPENSEA_API_KEY"' },

  // ── GitHub Actions / CI-CD ───────────────────────────────────────────────
  { label: "PRIVATE_KEY in workflow",    q: 'path:.github/workflows "PRIVATE_KEY" extension:yml' },
  { label: "MNEMONIC in workflow",       q: 'path:.github/workflows "MNEMONIC" extension:yml' },
  { label: "BEGIN RSA in workflow",      q: 'path:.github/workflows "BEGIN RSA PRIVATE KEY"' },
  { label: "hardcoded PAT in CI",        q: 'path:.github/workflows "ghp_" OR "github_pat_"' },

  // ── SSH Keys ──────────────────────────────────────────────────────────────
  { label: "OpenSSH Private Key",        q: '"BEGIN OPENSSH PRIVATE KEY"' },
  { label: "RSA Private Key",            q: '"BEGIN RSA PRIVATE KEY"' },
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
    await new Promise<void>((r) => setTimeout(r, queryDelayMs()));

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
      const url = `https://api.github.com/search/code?q=${encodeURIComponent(q + ' fork:false')}&per_page=30&page=1&sort=indexed&order=desc`;
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
