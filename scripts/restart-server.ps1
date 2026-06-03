# Restart the AI Assistant server without creating duplicate processes.
#
# Dev mode  (npm run dev / tsx watch running): touches src/server.ts to trigger reload.
# Prod mode (node dist/server.js running):    kills existing process, rebuilds, starts new one.

$projectRoot = Split-Path $PSScriptRoot -Parent
$pidFile     = Join-Path $projectRoot "server.pid"

# ── Detect running mode ─────────────────────────────────────────────────────

$tsxWatcher = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*ai-assist-tim*tsx*watch*server*" }

$compiledServer = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*ai-assist-tim*dist/server.js*" -or
                   $_.CommandLine -like "*ai-assist-tim*dist\server.js*" }

# ── Dev mode: let tsx watch handle the restart ───────────────────────────────

if ($tsxWatcher) {
    Write-Host "[restart] Dev mode detected (tsx watch PID $($tsxWatcher.ProcessId))"
    Write-Host "[restart] Touching src/server.ts to trigger tsx reload..."
    $serverTs = Join-Path $projectRoot "src\server.ts"
    (Get-Item $serverTs).LastWriteTime = Get-Date
    Write-Host "[restart] Done — tsx watch will restart the server momentarily."
    exit 0
}

# ── Prod mode: kill existing, build, start ───────────────────────────────────

Write-Host "[restart] Prod mode — no tsx watch detected."

# Kill via PID file first
if (Test-Path $pidFile) {
    $savedPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($savedPid) {
        Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
        Write-Host "[restart] Stopped previous server (PID $savedPid)"
    }
    Remove-Item $pidFile -Force
}

# Also kill any stray compiled-server processes
foreach ($proc in $compiledServer) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "[restart] Stopped stray server process (PID $($proc.ProcessId))"
}

# Build
Write-Host "[restart] Building TypeScript..."
Push-Location $projectRoot
$buildResult = & npm run build 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "[restart] Build failed:`n$buildResult"
    Pop-Location
    exit 1
}
Pop-Location
Write-Host "[restart] Build succeeded."

# Start compiled server
$logOut = Join-Path $projectRoot "server.log"
$logErr = Join-Path $projectRoot "server.err.log"
$proc = Start-Process -NoNewWindow -FilePath "node" `
    -ArgumentList (Join-Path $projectRoot "dist\server.js") `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError  $logErr `
    -PassThru

$proc.Id | Set-Content $pidFile
Write-Host "[restart] Server started (PID $($proc.Id)). Logs: server.log / server.err.log"
Start-Sleep -Seconds 2
Get-Content $logOut -ErrorAction SilentlyContinue | Select-Object -Last 8
