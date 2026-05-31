# Edit History — GH Dork

## 2026-05-31 — Session 5: 1 Perubahan (#24)

### #25 Value Preview — Copy on Click
- Badge `🔑 Value:` sekarang bisa diklik untuk menyalin teks preview ke clipboard
- Hover: badge menjadi lebih terang dan muncul teks `⎘ salin` di ujung kanan (fade-in CSS)
- Onclick memanggil `copyText(valuePreview)` + `event.stopPropagation()` agar tidak trigger aksi lain
- Berlaku di kedua card: auto-scan findings dan manual search results
- File: `artifacts/api-server/public/index.html` (CSS `.val-preview:hover`, `.val-preview-copy`, onclick di kedua card)

### #24 Value Preview — Potongan Nilai Terdeteksi (Disensor)
- Fungsi baru `extractValuePreview(snippet, filePath)` di backend: ekstrak nilai asli dari snippet dan sensor tengahnya
  - Format regex-confirmed keys: `ETH Key: 0xABCD...ef12`, `AWS Key: AKIA1234...WXYZ`, `GH Token: ghp_ABCD...ef12`, `BTC WIF: 5ABC...ef12`, `NEAR Key: ed25519:ABCD...ef12`, `xprv/zprv`, `Solana Key`, `Hex Key`
  - Format mnemonic (12/24 kata): `Mnemonic: word1 word2 ... wordN [12 words]`
  - Fallback assignment pattern: `KEY = "value"` → `valu...ef12`
  - Tidak ada preview jika tidak ada nilai yang bisa diekstrak
- Field `valuePreview: string` ditambah ke `AutoScanFinding` interface
- Auto-scan findings: `valuePreview` diisi saat `processPage()` membuat finding baru
- Manual search: `valuePreview` diisi di pipeline enrichment item (`data.items.map`)
- UI auto-scan card: badge kuning `🔑 Value: ETH Key: 0xABCD...ef12` muncul di bawah header card jika ada preview
- UI manual search card: badge yang sama muncul di atas snippet, hanya ketika ada nilai terdeteksi
- CSS: `.val-preview`, `.val-preview-label`, `.val-preview-wrap` — styling monospace kuning transparan
- File: `artifacts/api-server/src/routes/github.ts` (fungsi baru, interface update, processPage, enriched), `artifacts/api-server/public/index.html` (CSS, auto-scan card, manual search card)

## 2026-05-31 — Session 4: 2 Perubahan (#21–#22)

### #21 Fix False Positive CRITICAL — Placeholder & Empty Value Guard
- Tambah fungsi `isPlaceholderValue(snippet)`: deteksi nilai kosong/template seperti `PRIVATE_KEY=""`, `private_key = None`, `= "YOUR_KEY"`, `= 0x000...`, `= "xxx"`, `django-insecure`, dll.
- Tambah fungsi `isExampleOrTestFile(filePath)`: deteksi file template/test seperti `.env.example`, `.env.sample`, `.template`, `.md`, `/test/`, `/spec/`, `/fixture/`, `/mock/`, `/docs/` dll.
- Keyword-based CRITICAL sekarang hanya aktif jika `!isPlaceholderValue(snippet) && !isExampleOrTestFile(filePath)` — jika tidak terpenuhi, temuan jatuh ke level HIGH/MEDIUM secara alami
- Regex-based CRITICAL (format key asli seperti `0x[hex]{64}`, WIF key, ed25519:, xprv, dll) tetap selalu CRITICAL — tidak terpengaruh guard
- File: `artifacts/api-server/src/routes/github.ts` (dua fungsi baru sebelum `severity()`, modifikasi blok keyword CRITICAL)

### #23 Ekspansi Query Dork — Fokus Mnemonic & Private Key (+42 query baru)
- **More .env variants** (8 query): `.env.staging`, `.env.develop`, `.env.ci`, `.env.test`, `.env.backup`, `.env.prod`, `.env.mainnet`, `.env.testnet` — variant yang sering lupa tidak di-gitignore
- **Ethers.js / Web3.js patterns** (6 query): `Wallet.fromMnemonic`, `new ethers.Wallet`, `Wallet.fromPhrase` (ethers v6), `privateToAccount` (web3.js), `privateKeyToAccount` (viem), TypeScript variant
- **TypeScript patterns** (2 query): `language:typescript "PRIVATE_KEY"` dan `"mnemonic"` dengan guard ketat
- **Solana JS/TS SDK** (3 query): `Keypair.fromSecretKey`, `bs58.decode + secretKey`, `solanaKeypair JSON`
- **Python DeFi** (4 query): `brownie-config.yaml mnemonic`, `eth_account private_key`, `Account.from_key`, `HDWallet mnemonic`
- **Deployment & migration scripts** (5 query): `deploy.js/ts/py private_key`, `migrate.js mnemonic`, `path:scripts .env`
- **CI/CD** (4 query): `docker-compose.yml`, `.circleci`, `.gitlab-ci.yml`, `Jenkinsfile`
- **Config & secrets files** (6 query): `config.json/yaml/yml`, `secrets.json/yaml`, `appsettings.json`
- **Terraform / IaC** (2 query): `.tfvars private_key`, `.tf private_key`
- **Jupyter Notebooks** (2 query): `.ipynb private_key`, `.ipynb mnemonic` — data scientist/quant trader sering simpan key di notebook
- Total auto-scan queries naik dari 74 → **116 query**
- File: `artifacts/api-server/src/routes/github.ts` (array `AUTO_SCAN_QUERIES`)

### #22 Perbaikan Query — NOT example/sample/test/mock Guard
- Tambah `NOT example NOT sample NOT template` ke seluruh query `filename:.env` (74 query total)
- Tambah `NOT test NOT spec NOT mock` ke query bahasa: Python, Go, Rust, JavaScript
- Django: tambah `NOT "django-insecure"` ke `filename:settings.py "SECRET_KEY"` — filter placeholder default Django
- Hardhat/Truffle/Foundry: tambah `NOT example NOT test` untuk konfigurasi smart contract
- GitHub Actions workflows: tambah `NOT example`
- Keystore/vault/wallet JSON files: tambah `NOT test NOT example`
- File: `artifacts/api-server/src/routes/github.ts` (array `AUTO_SCAN_QUERIES`)

## 2026-05-31 — Session 3: 11 Perubahan (#10–#20)

### #15 Parallel Scan (⚡ 3–5× lebih cepat)
- Scan sekarang menjalankan beberapa query **sekaligus** — satu worker per token, max 5 paralel
- Implementasi: shared queue (`queueIndex++` atomic karena JS single-threaded) + `tokensInUse` Set mencegah dua worker pakai token yang sama
- Metode `TokenPool.pickExcluding(excluding: Set)` ditambahkan untuk memilih token yang tidak sedang dipakai
- Badge UI: `⚡ N worker paralel` muncul di sub-status Auto-Scan setelah scan selesai
- File: `github.ts` (method `pickExcluding`, refactor `runAutoScan` jadi worker-based)

### #16 Skip Query Sepi (🧠 hemat kuota)
- Query yang menghasilkan 0 temuan selama **3 scan berturut** masuk "cooldown"
- Durasi cooldown = `consecZero × intervalScan` (makin sering sepi → makin lama ditunda)
- Reset otomatis ketika query kembali menghasilkan temuan
- Status `queriesInCooldown` dipublish di `/api/autoscan/status` dan badge UI
- File: `github.ts` (Map `queryStats`, update loop stats pasca-scan)

### #17 Priority Queue (🎯 CRITICAL duluan)
- Semua query diurutkan sebelum scan: priority 0 = mnemonic/privatekey/keystore, priority 1 = api key/secret/token, priority 2 = lainnya
- Fungsi: `queryPriority(label)` — sorting via label keyword matching
- File: `github.ts` (fungsi `queryPriority`, sort di awal `runAutoScan`)

### #18 Incremental Window (📅 scan lebih presisi)
- Tiap query ingat kapan terakhir ada temuan (`queryStats.lastHitAt`)
- Window scan per query = `max(3, daysSinceLastHit + 1)` — tidak selalu 14 hari
- Query yang belum pernah menemukan apa pun tetap pakai `currentScanWindowDays` default
- Fungsi: `queryWindowDays(label)` di `github.ts`
- File: `github.ts` (fungsi baru, diterapkan di setiap query dalam worker)

### #19 Adaptive Interval (🔄 self-tuning)
- Jika scan menemukan ≥5 temuan: interval dipangkas 25% (min 15 menit)
- Jika 2 scan berturut menemukan 0: interval diperpanjang 50% (max 6 jam)
- Timer scan di-restart otomatis ketika interval berubah
- Badge UI: `📅 Adaptive: interval diperlambat` tampil saat consecutiveEmptyScans ≥ 2
- File: `github.ts` (konstanta `MIN/MAX_SCAN_INTERVAL_MS`, logika di akhir `runAutoScan`)

### #20 Dedup LOW/MEDIUM (🗂 kurangi CPU sia-sia)
- Item yang sudah dievaluasi sebagai LOW/MEDIUM di-cache per URL selama **24 jam**
- Mencegah pemanggilan `severity()` berulang untuk file yang sama setiap scan
- Map `seenLowMedium` (url → expiry ms), cleanup probabilistik 10% di awal setiap scan
- File: `github.ts` (Map + TTL constant `SEEN_LOW_TTL_MS`, cek di `processPage`)

---

## 2026-05-31 — Session 3: 5 Perubahan (#10–#14)

### #14 Token Health Dashboard
- Section "🔑 Token Health" collapsible di sidebar (klik untuk buka/tutup)
- Tampil otomatis hanya jika ada ≥1 token terkonfigurasi
- Per-token: suffix (4 karakter terakhir), sisa kuota (`remaining / 5000`), progress bar warna, badge status, countdown reset
- Badge status: `OK` (hijau, >20%), `LOW` (kuning, 5–20%), `CRIT` (merah, ≤5%), `DEAD` (ungu, errors ≥ 3)
- Data diambil dari `/api/github/config` (`tokens` field) yang di-refresh setiap 30 detik — tanpa endpoint baru
- File: `index.html` (CSS `.th-*`, HTML `#th-wrap`/`#th-list`, JS `renderTokenHealth()`, `toggleTokenHealth()`, update `fetchConfig()`)

---

## 2026-05-31 — Session 3: 4 Perubahan (#10–#13)

### #10 Export CSV/JSON
- Tombol ⬇ CSV dan ⬇ JSON di header "Temuan Terbaru" tab Auto-Scan
- Endpoint: `GET /api/autoscan/export?format=csv|json`
- CSV berisi kolom: timestamp, severity, repo, path, query, queryLabel, fileUrl
- Download langsung via `<a>` click — tidak perlu library tambahan
- File: `github.ts` (route baru), `index.html` (tombol + fungsi `exportFindings()`)

### #11 Discord & Slack Webhook
- Notifikasi dikirim ke Discord dan Slack bersamaan dengan Telegram
- Set `DISCORD_WEBHOOK_URL` dan/atau `SLACK_WEBHOOK_URL` di Replit Secrets
- Status Discord/Slack tampil di sidebar (dot hijau = aktif, kuning = belum diset)
- Berlaku untuk: manual search hits DAN auto-scan findings
- Format pesan: plain text (Discord/Slack tidak support HTML Telegram)
- File: `github.ts` (fungsi `sendDiscord()`, `sendSlack()`, update config endpoint), `index.html` (2 status row baru, update `updateStatus()`)

### #12 Repo Blocklist
- Blokir repo false positive dari UI — tidak akan muncul lagi di auto-scan
- Disimpan permanen di `artifacts/api-server/data/blocklist.json`
- Tombol 🚫 di setiap finding card auto-scan → confirm dialog → langsung terblokir
- Manajemen manual: tambah/hapus repo di card "🚫 Repo Blocklist" tab Auto-Scan
- Filter diterapkan di server-side dalam `processPage()` sebelum severity check
- Endpoints: `GET/POST /api/autoscan/blocklist`, `DELETE /api/autoscan/blocklist/:index`
- File: `github.ts` (load/save/CRUD blocklist, filter di processPage), `index.html` (card UI, fungsi `addToBlocklist()`, `removeFromBlocklist()`, `blockRepoFromBtn()`, `renderBlocklist()`, `fetchBlocklist()`)

### #13 Preferensi Dokumentasi
- Semua modifikasi, edit, dan penambahan fitur wajib dicatat di `edit.md`
- Preferensi disimpan ke `replit.md` bagian "User preferences"
- File: `replit.md`, `edit.md`

---

## 2026-05-31 — Session 2: 6 Major Features (#1–#9)

### #1 Persistent Findings
- Temuan auto-scan disimpan ke `artifacts/api-server/data/findings.json`
- `seenFindings` keys (hash-based) juga dipersist — tidak hilang saat restart
- Fungsi: `loadPersistedFindings()`, `saveFindings()` di `github.ts`
- Dipanggil: load saat startup, save setelah setiap scan + saat `seenFindings` di-reset

### #2 Auto-Scan Page 2
- Jika halaman 1 penuh (30 hasil) dan token masih ada (`remaining > 5`), otomatis fetch halaman 2
- Menambah jangkauan deteksi tanpa membebani rate limit berlebihan
- Implementasi: helper `processPage()` dipakai untuk kedua halaman dalam loop scan

### #3 Rate Limiter Search Endpoint
- Max 10 request/menit per IP pada `GET /api/github/search`
- Sliding window 60 detik, IP dari header `x-forwarded-for` atau socket
- Return 429 jika melebihi limit
- Cleanup otomatis entry stale tiap 5 menit

### #4 Leaderboard Query
- Tabel "🏆 Query Paling Produktif" di tab Auto-Scan
- Menampilkan top-10 query berdasarkan jumlah finding, dengan bar visual
- Data dari `autoScanState.queryHits` (per-query hit counter, persists process lifetime)
- UI: `renderLeaderboard()` di `index.html`, medal emoji 🥇🥈🥉 untuk top 3

### #5 Blockchain Explorer Links
- CRITICAL cards tampilkan link langsung ke blockchain explorer (Etherscan, BSCScan, dll)
- Deteksi alamat wallet via regex + keyword detection dari path + snippet
- Fungsi: `detectExplorerLinks()` di `index.html` — client-side only, tanpa backend

### #6 Custom Queries
- Tambah/hapus query GitHub sendiri dari UI tab Auto-Scan
- Tersimpan di `artifacts/api-server/data/custom-queries.json` — survives restart
- Endpoints: `GET/POST /api/autoscan/custom-queries`, `DELETE /api/autoscan/custom-queries/:index`
- UI: card baru di halaman Auto-Scan dengan form input label + query + tombol hapus per item

### #7 Window Config
- Dropdown "📅 Window cari" baru: pilih 7 / 14 / 30 hari (default 14)
- Menggantikan hardcoded `14` di query `pushed:>DATE`
- Endpoint: `POST /api/autoscan/window?days=`
- State di-sync ke dropdown saat `renderAutoScan()` dipanggil

### #8 Hash-Based Deduplication
- `seenFindings` sekarang menyimpan key `url|md5(snippet[:200])` bukan hanya URL
- File yang URL-nya sama tapi isinya berubah → terdeteksi sebagai finding baru
- Fungsi: `findingKey(url, snippet)` menggunakan `crypto.createHash("md5")`
- LOW/MEDIUM tetap tidak di-cache (hanya CRITICAL/HIGH yang masuk `seenFindings`)

### #9 Data Persistence Path
- Semua data disimpan ke `artifacts/api-server/data/` (bukan `dist/` — survives rebuild)
- File: `findings.json`, `custom-queries.json`, `blocklist.json`
- Direktori dibuat otomatis saat startup jika belum ada

---

## 2026-05-31 — Session 1: Migrasi + 11 Bug Fix

### Migrasi ke Replit
- `pnpm install`, konfigurasi workflow "GH Dork Web"
- Secret `GITHUB_TOKEN` dikonfirmasi aktif

### Freshness Bugs (5 fix)
- `pickDork` dan `rerun` sekarang panggil `doSearch()` bukan `runSearch()`
- `rerunSaved` juga diperbaiki ke `doSearch()`
- Window auto-scan: 90 hari → 14 hari
- `seenFindings` direset tiap 7 hari (sebelumnya tidak pernah reset)
- Telegram manual search hanya kirim notif untuk repo `pushed` < 30 hari

### Auto-Inject Freshness Filter
- Backend otomatis inject `pushed:>30d` jika query belum ada filter pushed
- Berlaku untuk semua pencarian manual

### Strict Mode Fix
- HIGH tidak lagi lolos di strict mode (seharusnya CRITICAL-Only)
- Cek `sev !== "CRITICAL"` ditambahkan sebelum regex check

### seenFindings Add Order Fix
- `seenFindings.add()` dipindah ke setelah severity check
- Sebelumnya: URL LOW/MEDIUM di-cache dan tidak pernah di-re-check

### TypeScript Interface Fix
- `GitHubSearchResponse` interface ditambah `pushed_at`, `fork`, `archived` pada `repository`

### Freshness Badge UI
- Badge warna-warni pada result card: 🟢 (≤7d) / 🟡 (8-30d) / ⚫ (>30d)
- Relative time: "2d ago", "18d ago" + hover tooltip

### Info Bar Fix
- Teks "90 hari terakhir" diperbaiki menjadi "30 hari terakhir"

### Batch Search Window Fix
- Batch search window: 90 hari → 30 hari
