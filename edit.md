# Edit History — GH Dork

## 2026-05-31 — Session 3: 3 New Features

### #9 Export CSV/JSON
- Tombol ⬇ CSV dan ⬇ JSON di header "Temuan Terbaru" tab Auto-Scan
- Endpoint: `GET /api/autoscan/export?format=csv|json`
- CSV berisi kolom: timestamp, severity, repo, path, query, queryLabel, fileUrl
- Download langsung via `<a>` click — tidak perlu library tambahan

### #10 Discord & Slack Webhook
- Notifikasi dikirim ke Discord dan Slack bersamaan dengan Telegram
- Set `DISCORD_WEBHOOK_URL` dan/atau `SLACK_WEBHOOK_URL` di Replit Secrets
- Status Discord/Slack tampil di sidebar (dot hijau = aktif, kuning = belum diset)
- Berlaku untuk: manual search hits DAN auto-scan findings
- Format pesan: plain text (Discord/Slack tidak support HTML Telegram)

### #11 Repo Blocklist
- Blokir repo false positive dari UI — tidak akan muncul lagi di auto-scan
- Disimpan permanen di `artifacts/api-server/data/blocklist.json`
- Tombol 🚫 di setiap finding card auto-scan → confirm dialog → langsung terblokir
- Manajemen manual: tambah/hapus repo di card "Blocklist" tab Auto-Scan
- Filter diterapkan di server-side dalam `processPage()` sebelum severity check
- Endpoints: `GET/POST /api/autoscan/blocklist`, `DELETE /api/autoscan/blocklist/:index`

---

## 2026-05-31 — Session 2: 6 Major Features

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

### #6 Custom Queries
- Tambah/hapus query GitHub sendiri dari UI tab Auto-Scan
- Tersimpan di `artifacts/api-server/data/custom-queries.json` — survives restart
- New endpoints: `GET/POST /api/autoscan/custom-queries`, `DELETE /api/autoscan/custom-queries/:index`
- UI: card baru di halaman Auto-Scan dengan form input label + query + tombol hapus per item

### #7 Window Config
- Dropdown "📅 Window cari" baru: pilih 7 / 14 / 30 hari (default 14)
- Menggantikan hardcoded `14` di query `pushed:>DATE`
- New endpoint: `POST /api/autoscan/window?days=`
- State di-sync ke dropdown saat `renderAutoScan()` dipanggil

### #8 Hash-Based Deduplication
- `seenFindings` sekarang menyimpan key `url|md5(snippet[:200])` bukan hanya URL
- File yang URL-nya sama tapi isinya berubah → terdeteksi sebagai finding baru
- Fungsi: `findingKey(url, snippet)` menggunakan `crypto.createHash("md5")`
- LOW/MEDIUM tetap tidak di-cache (hanya CRITICAL/HIGH yang masuk `seenFindings`)

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
