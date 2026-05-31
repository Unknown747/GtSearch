/**
 * Standalone crypto scan runner.
 * Starts the server, triggers one auto-scan, waits for completion, then exits.
 * Usage: node ./crypto-scan.mjs
 * Env:   PORT (default 8080), all TOKEN_* and notification secrets
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const PORT = process.env.PORT || 8080;
const BASE_URL = `http://localhost:${PORT}`;
const SCAN_TIMEOUT_MS = 55 * 60 * 1000; // 55 minutes max
const STARTUP_TIMEOUT_MS = 60 * 1000;   // 60s to start

console.log("[crypto-scan] Starting server on port", PORT);

const server = spawn(
  "node",
  ["--enable-source-maps", "./dist/index.mjs"],
  {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

server.stderr.pipe(process.stderr);

let started = false;
let exitCode = 0;

function shutdown(code = 0) {
  if (!server.killed) server.kill("SIGTERM");
  setTimeout(() => process.exit(code), 2000);
}

// Startup watchdog
const startupTimer = setTimeout(() => {
  if (!started) {
    console.error("[crypto-scan] Server failed to start within 60s");
    shutdown(1);
  }
}, STARTUP_TIMEOUT_MS);

const rl = createInterface({ input: server.stdout });
rl.on("line", async (line) => {
  process.stdout.write("[server] " + line + "\n");

  if (!started && (line.includes("Server listening") || line.includes('"port"'))) {
    started = true;
    clearTimeout(startupTimer);
    console.log("[crypto-scan] Server ready — triggering scan...");

    try {
      // Trigger scan
      const r = await fetch(`${BASE_URL}/api/autoscan/run-now`, { method: "POST" });
      const d = await r.json();
      console.log("[crypto-scan] Scan response:", JSON.stringify(d));

      if (!d.ok && d.message) {
        console.warn("[crypto-scan] Scan not started:", d.message);
      }

      // Watch SSE for scan-complete
      console.log("[crypto-scan] Waiting for scan-complete event (max 55 min)...");
      const scanDeadline = Date.now() + SCAN_TIMEOUT_MS;

      const es = await fetch(`${BASE_URL}/api/autoscan/events`);
      const reader = es.body.getReader();
      const dec = new TextDecoder();

      while (Date.now() < scanDeadline) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value);

        if (text.includes("scan-complete")) {
          console.log("[crypto-scan] Scan completed!");

          // Export findings summary
          try {
            const exp = await fetch(`${BASE_URL}/api/latest-results`);
            const data = await exp.json();
            const s = data.stats || {};
            console.log("[crypto-scan] Results summary:");
            console.log("  Total findings:  ", s.total ?? 0);
            console.log("  CRITICAL:        ", s.bySeverity?.CRITICAL ?? 0);
            console.log("  HIGH:            ", s.bySeverity?.HIGH ?? 0);
            console.log("  Total scans:     ", s.scanCount ?? 0);
            if (s.byCategory) {
              console.log("  By category:");
              for (const [cat, cnt] of Object.entries(s.byCategory)) {
                console.log(`    ${cat}: ${cnt}`);
              }
            }
          } catch (e) {
            console.warn("[crypto-scan] Could not fetch results summary:", e.message);
          }

          shutdown(0);
          return;
        }

        if (text.includes("scan-progress")) {
          const match = text.match(/"percent":(\d+)/);
          if (match) process.stdout.write(`\r[crypto-scan] Progress: ${match[1]}%   `);
        }
      }

      console.log("\n[crypto-scan] Scan timeout reached");
      shutdown(0);
    } catch (err) {
      console.error("[crypto-scan] Fatal error:", err);
      shutdown(1);
    }
  }
});

server.on("exit", (code) => {
  console.log("[crypto-scan] Server exited with code", code);
  process.exit(exitCode);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
