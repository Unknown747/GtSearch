# GH Dork CLI — Blockchain & Crypto Sensitive Data Scanner

Node.js 18+ CLI tool. No external dependencies. Single file.

## Quick Start

```bash
# Clone or copy index.js to your machine
# Set your GitHub Personal Access Token (classic, needs 'repo' scope)

GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx node index.js --all
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | Single GitHub PAT (classic). Needs `repo` and `read:user` scopes |
| `TOKEN_ARRAY` | Comma-separated list of tokens for automatic rotation |

## Options

```
--all                     Run all 69 dork queries
--category <name>         Run queries from a specific category only
--query <q>               Run a single custom search query
--scope <user|org>        Scope all searches to a GitHub username or org
--validate                Enable 2-layer credential validation (heuristic + regex)
--format <json|csv|txt|md>  Output format (default: json)
--output <file>           Output file path (auto-named if not specified)
--delay <ms>              Delay between API requests in ms (default: 1200)
--max-results <n>         Results per query, max 100 (default: 30)
--list-categories         List all available dork categories
--verbose                 Debug/verbose logging
--help                    Show help
```

## Examples

```bash
# Scan everything, export as markdown report
GITHUB_TOKEN=ghp_xxx node index.js --all --format md --output report.md

# Only scan private keys, validate results
GITHUB_TOKEN=ghp_xxx node index.js --category "Private Keys" --validate

# Scope scan to a specific GitHub user
GITHUB_TOKEN=ghp_xxx node index.js --category "Exchange API Keys" --scope targetuser

# Multi-token rotation for large scans (avoids rate limits)
TOKEN_ARRAY=ghp_a,ghp_b,ghp_c node index.js --all --delay 800 --format csv

# Custom query
GITHUB_TOKEN=ghp_xxx node index.js --query 'filename:.env "PRIVATE_KEY" solana'

# List categories
node index.js --list-categories
```

## Dork Categories (69 total queries)

| # | Category | Queries |
|---|----------|---------|
| 1 | Private Keys | 15 |
| 2 | Seed Phrases & Mnemonics | 10 |
| 3 | Exchange API Keys | 12 |
| 4 | Wallet Configuration Files | 8 |
| 5 | Web3 Framework Files | 8 |
| 6 | RPC & Node Credentials | 6 |
| 7 | Payment Gateways | 4 |
| 8 | Backup & Exposed Files | 6 |

## Validation Layers

When `--validate` is enabled:

**Layer 1 — Heuristic Filter:** Rejects snippets containing test/example/dummy/placeholder values and junk file paths (`/test/`, `/fixtures/`, etc.)

**Layer 2 — Format Validation (Regex):**
- Ethereum Private Key: `^(0x)?[a-fA-F0-9]{64}$`
- Bitcoin WIF: `^[5KL][1-9A-HJ-NP-Za-km-z]{50,52}$`
- Solana Keypair: `^[1-9A-HJ-NP-Za-km-z]{87,88}$`
- BIP39 12-word: `^([a-z]+ ){11}[a-z]+$`
- BIP39 24-word: `^([a-z]+ ){23}[a-z]+$`
- Stripe Live Key: `^sk_live_[a-zA-Z0-9]{24,}$`

## Output Formats

| Format | Description |
|--------|-------------|
| `json` | Full structured JSON with all fields |
| `csv` | Spreadsheet-compatible |
| `txt` | Human-readable plain text report |
| `md` | Markdown report with severity grouping |

## Severity Levels

| Level | Triggered By |
|-------|-------------|
| `CRITICAL` | Private keys, mnemonics, seed phrases, keystores, id_rsa |
| `HIGH` | Passwords, secrets, JWT keys, live Stripe keys |
| `MEDIUM` | API keys, tokens, RPC URLs, Infura/Alchemy |
| `LOW` | Config files, generic credentials |

## Rate Limiting

- Smart rate limit detection via `x-ratelimit-remaining` header
- If remaining < 5: rotates to next token (if `TOKEN_ARRAY` set) or sleeps until reset + 5s
- Secondary rate limit (HTTP 403): automatic 60s backoff
- Default 1200ms delay between requests to stay well within limits

## Legal Notice

This tool is for **security research and authorized auditing only**. Only scan repositories you own or have explicit written permission to audit. Unauthorized scanning may violate GitHub's Terms of Service and applicable computer crime laws.
