/**
 * Wraps `tsx watch src/server.ts` so that stdout AND stderr are written
 * to both the terminal (real-time) and the log files simultaneously.
 *
 * Log files:
 *   logs/dev-server.out.log  ← stdout (console.log, Fastify JSON lines)
 *   logs/dev-server.err.log  ← stderr (console.error, warnings)
 *
 * Each dev session is separated by a timestamped banner so you can tell
 * restarts apart when reading the log files later.
 *
 * Also watches .env for changes and sends SIGHUP to tsx watch so that
 * env variable changes take effect without a full manual restart.
 */

import { spawn } from "child_process";
import { createWriteStream, mkdirSync, watch } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

mkdirSync(resolve(root, "logs"), { recursive: true });

const outPath = resolve(root, "logs/dev-server.out.log");
const errPath = resolve(root, "logs/dev-server.err.log");

const outLog = createWriteStream(outPath, { flags: "a" });
const errLog = createWriteStream(errPath, { flags: "a" });

const ts = new Date().toISOString();
const banner = `\n${"─".repeat(72)}\n[Dev session started: ${ts}]\n${"─".repeat(72)}\n`;
outLog.write(banner);
errLog.write(banner);

// Resolve tsx from local node_modules/.bin so the script works regardless of
// whether node_modules/.bin is in PATH (npm scripts add it; direct node invocation may not).
const isWin = process.platform === "win32";
const tsxBin = resolve(root, "node_modules/.bin", isWin ? "tsx.cmd" : "tsx");

const child = spawn(isWin ? process.env.ComSpec || "cmd.exe" : tsxBin,
  isWin ? ["/d", "/c", tsxBin, "watch", "src/server.ts"] : ["watch", "src/server.ts"],
  {
    cwd: root,
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
    shell: false,
  }
);

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  outLog.write(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  errLog.write(chunk);
});

child.on("error", (err) => {
  const msg = `[dev-with-logging] spawn error: ${err.message}\n`;
  process.stderr.write(msg);
  errLog.write(msg);
});

child.on("close", (code) => {
  const msg = `[dev-with-logging] exited (code ${code})\n`;
  outLog.write(msg);
  outLog.end(() => process.exit(code ?? 0));
  errLog.end();
});

// Forward Ctrl+C / SIGTERM so tsx watch shuts down cleanly
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

// Watch .env for changes and signal tsx watch to restart.
// tsx watch responds to SIGHUP on Unix; on Windows we use the undocumented
// trick of touching a watched .ts file — we write a harmless comment to
// a small sentinel file that tsx already watches.
const envPath = resolve(root, ".env");
let envDebounce = null;
try {
  watch(envPath, () => {
    if (envDebounce) return;
    envDebounce = setTimeout(() => {
      envDebounce = null;
      const notice = `[dev-with-logging] .env changed — restarting tsx watch to pick up new env vars\n`;
      process.stdout.write(notice);
      outLog.write(notice);
      // On Windows SIGTERM kills the child; tsx watch's parent (this process)
      // will exit too via the close handler above, so npm run dev must be re-run.
      // Use SIGUSR1 if available (non-Windows), otherwise kill and let npm restart.
      if (!isWin) {
        child.kill("SIGHUP");
      } else {
        // On Windows: kill the child — the user must re-run npm run dev.
        // tsx watch cannot be HUP'd on Windows, but the log will tell them.
        child.kill("SIGTERM");
      }
    }, 300);
  });
} catch {
  // .env watch is best-effort — failure here must not break the server
}
