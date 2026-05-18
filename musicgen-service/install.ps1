$ErrorActionPreference = "Stop"

Write-Host "=== MusicGen Service Installer ===" -ForegroundColor Cyan

function Find-CompatiblePython {
    foreach ($ver in @("3.12", "3.11", "3.10")) {
        if (Get-Command py -ErrorAction SilentlyContinue) {
            $ErrorActionPreference = "SilentlyContinue"
            py -$ver -c "import sys" 2>$null | Out-Null
            $ok = $LASTEXITCODE -eq 0
            $ErrorActionPreference = "Stop"
            if ($ok) { return "py -$ver" }
        }
    }
    foreach ($cmd in @("python", "python3")) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) {
            $ver = & $cmd -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
            if ([int]($ver.Split(".")[1]) -le 12) { return $cmd }
            Write-Host "Found $cmd ($ver) but PyTorch requires <= 3.12" -ForegroundColor Yellow
        }
    }
    return $null
}

function Is-Installed($pkg) {
    $ErrorActionPreference = "SilentlyContinue"
    pip show $pkg 2>$null | Out-Null
    $ok = $LASTEXITCODE -eq 0
    $ErrorActionPreference = "Stop"
    return $ok
}

function Install-Pkg($label, $pipArgs) {
    Write-Host "Installing $label..."
    $ErrorActionPreference = "SilentlyContinue"
    Invoke-Expression "pip install $pipArgs"
    $ok = $LASTEXITCODE -eq 0
    $ErrorActionPreference = "Stop"
    if (-not $ok) {
        Write-Host "ERROR: failed to install $label" -ForegroundColor Red
        exit 1
    }
    Write-Host "$label installed OK" -ForegroundColor Green
}

# Find Python
$pythonExe = Find-CompatiblePython
if (-not $pythonExe) {
    Write-Host "ERROR: No compatible Python (3.10-3.12) found." -ForegroundColor Red
    Write-Host "Install Python 3.12 from https://python.org/downloads/" -ForegroundColor Yellow
    exit 1
}
Write-Host "Using: $pythonExe" -ForegroundColor Green

# Create or reuse venv
$needVenv = $true
if (Test-Path "venv\Scripts\python.exe") {
    $venvVer = & "venv\Scripts\python.exe" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
    if ([int]($venvVer.Split(".")[1]) -le 12) {
        Write-Host "Existing venv OK (Python $venvVer)" -ForegroundColor Green
        $needVenv = $false
    } else {
        Write-Host "Rebuilding venv (was Python $venvVer)..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force venv
    }
}

if ($needVenv) {
    Write-Host "Creating virtual environment..."
    Invoke-Expression "$pythonExe -m venv venv"
}

& "venv\Scripts\Activate.ps1"
python -m pip install --upgrade pip --quiet

# Detect CUDA once — used for torch install and re-pin at end
$cudaVersion = $null
$torchIndex  = "https://download.pytorch.org/whl/cpu"
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    $smi = nvidia-smi | Select-String "CUDA Version"
    if ($smi -match "CUDA Version:\s*(\d+)\.(\d+)") {
        $cudaVersion = "$($Matches[1]).$($Matches[2])"
        $cudaMajor   = [int]($Matches[1])
        $torchIndex  = if ($cudaMajor -ge 12) { "https://download.pytorch.org/whl/cu124" }
                       elseif ($cudaMajor -eq 11) { "https://download.pytorch.org/whl/cu118" }
                       else { "https://download.pytorch.org/whl/cpu" }
        Write-Host "GPU detected - CUDA $cudaVersion" -ForegroundColor Green
    }
} else {
    Write-Host "No GPU detected - will use CPU PyTorch" -ForegroundColor Yellow
}

# PyTorch + torchaudio — check both independently
$torchOk      = Is-Installed "torch"
$torchaudioOk = Is-Installed "torchaudio"

if ($torchOk -and $torchaudioOk) {
    $v = pip show torch 2>$null | Select-String "^Version:" | ForEach-Object { $_ -replace "Version:\s*","" }
    Write-Host "torch $v + torchaudio already installed - skipping" -ForegroundColor Green
} else {
    Install-Pkg "torch + torchaudio" "torch torchaudio --index-url $torchIndex"
}

# numpy
if (Is-Installed "numpy") {
    Write-Host "numpy already installed - skipping" -ForegroundColor Green
} else {
    Install-Pkg "numpy" "numpy --prefer-binary --quiet"
}

# spacy — pre-built wheel required on Windows (avoids thinc C compilation)
if (Is-Installed "spacy") {
    Write-Host "spacy already installed - skipping" -ForegroundColor Green
} else {
    Install-Pkg "spacy" "spacy --prefer-binary --quiet"
}

# audiocraft dependencies that may need binary wheels
foreach ($pkg in @(
    "encodec", "demucs", "num2words", "flashy",
    "soundfile", "librosa", "einops", "omegaconf",
    "huggingface_hub", "transformers", "hydra-core", "hydra_colorlog",
    "protobuf", "sentencepiece", "torchmetrics", "av"
)) {
    if (Is-Installed $pkg) {
        Write-Host "$pkg already installed - skipping" -ForegroundColor Green
    } else {
        Install-Pkg $pkg "$pkg --prefer-binary --quiet"
    }
}

# xformers — must come from same index as torch so the build matches exactly
# Always force-reinstall to ensure correct version for current torch
Write-Host "Installing xformers (matched to torch index)..."
Install-Pkg "xformers" "xformers --index-url $torchIndex --no-deps --force-reinstall"

# audiocraft itself
if (Is-Installed "audiocraft") {
    Write-Host "audiocraft already installed - skipping" -ForegroundColor Green
} else {
    Install-Pkg "audiocraft" "audiocraft --prefer-binary --no-deps"
}

# Re-pin torch+torchaudio last — other deps may have upgraded them
Write-Host "Re-pinning torch+torchaudio to correct CUDA version..."
if ($cudaVersion) {
    $cudaMajor = [int]($cudaVersion.Split(".")[0])
    $idx = if ($cudaMajor -ge 12) { "https://download.pytorch.org/whl/cu124" }
           elseif ($cudaMajor -eq 11) { "https://download.pytorch.org/whl/cu118" }
           else { "https://download.pytorch.org/whl/cpu" }
    Install-Pkg "torch + torchaudio (re-pin CUDA)" "torch torchaudio --index-url $idx --force-reinstall --no-deps"
} else {
    Install-Pkg "torch + torchaudio (re-pin CPU)" "torch torchaudio --index-url https://download.pytorch.org/whl/cpu --force-reinstall --no-deps"
}

# fastapi + uvicorn
if (Is-Installed "fastapi") {
    Write-Host "fastapi already installed - skipping" -ForegroundColor Green
} else {
    Install-Pkg "fastapi + uvicorn" "fastapi `"uvicorn[standard]`" --quiet"
}

Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Add to your .env:"
Write-Host "  MUSICGEN_MODE=external"
Write-Host "  MUSICGEN_API_URL=http://localhost:8001"
Write-Host "  MUSICIAN_GENERATION_ENABLED=true"
Write-Host ""
Write-Host "Then run: .\start.ps1"
Write-Host "(First start downloads the model ~3GB - one-time only)"
