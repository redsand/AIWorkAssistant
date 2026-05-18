#!/bin/bash
set -e

echo "=== MusicGen Service Installer ==="

# Check Python
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Install Python 3.10+ first."
  exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Python: $PYTHON_VERSION"

# Create venv
if [ ! -d "venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv venv
fi

source venv/bin/activate

echo "Upgrading pip..."
pip install --upgrade pip --quiet

# Install PyTorch with CUDA — detect CUDA version
if command -v nvidia-smi &>/dev/null; then
  CUDA_VERSION=$(nvidia-smi | grep -oP "CUDA Version: \K[0-9]+\.[0-9]+" | head -1)
  echo "GPU detected — CUDA $CUDA_VERSION"

  if [[ "$CUDA_VERSION" == 12.* ]]; then
    TORCH_INDEX="https://download.pytorch.org/whl/cu121"
  elif [[ "$CUDA_VERSION" == 11.* ]]; then
    TORCH_INDEX="https://download.pytorch.org/whl/cu118"
  else
    echo "WARNING: Unknown CUDA version, defaulting to cu121"
    TORCH_INDEX="https://download.pytorch.org/whl/cu121"
  fi

  echo "Installing PyTorch (CUDA $CUDA_VERSION)..."
  pip install torch torchaudio --index-url "$TORCH_INDEX" --quiet
else
  echo "WARNING: No GPU detected — installing CPU-only PyTorch (generation will be slow)"
  pip install torch torchaudio --index-url "https://download.pytorch.org/whl/cpu" --quiet
fi

echo "Installing audiocraft and API dependencies..."
pip install audiocraft fastapi "uvicorn[standard]" --quiet

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Set MUSICGEN_MODEL in .env (default: facebook/musicgen-medium)"
echo "     Options: facebook/musicgen-small | facebook/musicgen-medium | facebook/musicgen-large"
echo "  2. Run:  ./start.sh"
echo "  3. First run will download the model (~3GB for medium) — this is one-time only"
