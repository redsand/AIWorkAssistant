$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Test-Path "venv")) {
    Write-Error "venv not found - run .\install.ps1 first"
    exit 1
}

# Verify the venv Python is compatible before activating
$venvPython = "venv\Scripts\python.exe"
$pyVer = & $venvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>&1
$pyMinor = [int]($pyVer.Split(".")[1])
if ($pyMinor -gt 12) {
    Write-Host "ERROR: venv is using Python $pyVer which is incompatible with PyTorch." -ForegroundColor Red
    Write-Host "Re-run .\install.ps1 to rebuild the venv with Python 3.12." -ForegroundColor Yellow
    exit 1
}

& "venv\Scripts\Activate.ps1"

# Load relevant vars from ../.env if it exists
$envFile = Join-Path $PSScriptRoot "..\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match "^(MUSICGEN_|HF_)" } | ForEach-Object {
        $parts = $_ -split "=", 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}

if (-not $env:MUSICGEN_MODEL)        { $env:MUSICGEN_MODEL = "facebook/musicgen-small" }
if (-not $env:MUSICGEN_OUTPUT_DIR)   { $env:MUSICGEN_OUTPUT_DIR = "..\generated-audio" }
if (-not $env:MUSICGEN_MAX_DURATION) { $env:MUSICGEN_MAX_DURATION = "60" }
if (-not $env:MUSICGEN_SERVICE_PORT) { $env:MUSICGEN_SERVICE_PORT = "8001" }

New-Item -ItemType Directory -Force -Path $env:MUSICGEN_OUTPUT_DIR | Out-Null

Write-Host "Starting MusicGen service on port $($env:MUSICGEN_SERVICE_PORT)" -ForegroundColor Cyan
Write-Host "Model:  $($env:MUSICGEN_MODEL)"
Write-Host "Output: $($env:MUSICGEN_OUTPUT_DIR)"
Write-Host "Python: $pyVer"
Write-Host ""
Write-Host "First run downloads the model (~3GB) - subsequent starts are fast." -ForegroundColor Yellow
Write-Host ""

uvicorn app:app --host 0.0.0.0 --port $env:MUSICGEN_SERVICE_PORT
