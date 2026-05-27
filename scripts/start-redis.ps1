# Start Redis Server in Background
# Starts redis-server as a background process and logs output

$REDIS_LOG_DIR = Join-Path $PSScriptRoot "..\.redis"
$REDIS_LOG_FILE = Join-Path $REDIS_LOG_DIR "redis.log"

# Create log directory if it doesn't exist
if (!(Test-Path $REDIS_LOG_DIR)) {
    New-Item -ItemType Directory -Force -Path $REDIS_LOG_DIR | Out-Null
}

# Check if Redis is already running
$existingProcess = Get-Process redis-server -ErrorAction SilentlyContinue
if ($existingProcess) {
    Write-Host "Redis is already running (PID: $($existingProcess.Id))"
    exit 0
}

# Start Redis server in background
Write-Host "Starting Redis server..."
Start-Process -FilePath "redis-server" `
    -ArgumentList "--logfile `"$REDIS_LOG_FILE`"" `
    -WindowStyle Hidden `
    -PassThru

# Wait briefly for startup
Start-Sleep -Milliseconds 500

# Verify it started
$redisProcess = Get-Process redis-server -ErrorAction SilentlyContinue
if ($redisProcess) {
    Write-Host "Redis started successfully (PID: $($redisProcess.Id))"
    Write-Host "Log file: $REDIS_LOG_FILE"
} else {
    Write-Error "Failed to start Redis server"
    exit 1
}
