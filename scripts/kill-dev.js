#!/usr/bin/env node
/**
 * Kill any process listening on the configured PORT (default 3050).
 * Cross-platform: uses PowerShell on Windows, lsof on macOS/Linux.
 */
const { execSync } = require("child_process");
const os = require("os");

const PORT = process.env.PORT || "3050";

function getPids() {
  if (os.platform() === "win32") {
    try {
      const out = execSync(
        `powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { if ($_ -ne 0) { $_ } }"`,
        { encoding: "utf8", timeout: 5000 },
      );
      return out
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && s !== "0" && !isNaN(Number(s)))
        .map(Number);
    } catch {
      return [];
    }
  } else {
    try {
      const out = execSync(
        `lsof -ti:${PORT}`,
        { encoding: "utf8", timeout: 5000 },
      );
      return out
        .trim()
        .split("\n")
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n) && n > 0);
    } catch {
      return [];
    }
  }
}

function main() {
  const pids = getPids();
  if (pids.length === 0) {
    console.log(`[kill-dev] No process listening on port ${PORT}`);
    return;
  }

  console.log(`[kill-dev] Found PIDs on port ${PORT}: ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`[kill-dev] Sent SIGTERM to PID ${pid}`);
    } catch (err) {
      console.error(`[kill-dev] Failed to kill PID ${pid}:`, err.message);
    }
  }

  // Brief grace period then SIGKILL if still alive
  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 0); // test if alive
        console.log(`[kill-dev] PID ${pid} still alive — sending SIGKILL…`);
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }, 1500);
}

main();
