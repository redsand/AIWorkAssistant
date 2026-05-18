#!/bin/bash
set -e

cd "$(dirname "$0")"

if [ ! -d "venv" ]; then
  echo "venv not found — run ./install.sh first"
  exit 1
fi

source venv/bin/activate

# Load .env from project root if it exists
ENV_FILE="../.env"
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | grep -E 'MUSICGEN_|HF_' | xargs)
fi

export MUSICGEN_MODEL="${MUSICGEN_MODEL:-facebook/musicgen-medium}"
export MUSICGEN_OUTPUT_DIR="${MUSICGEN_OUTPUT_DIR:-../generated-audio}"
export MUSICGEN_MAX_DURATION="${MUSICGEN_MAX_DURATION:-60}"
PORT="${MUSICGEN_SERVICE_PORT:-8001}"

mkdir -p "$MUSICGEN_OUTPUT_DIR"

echo "Starting MusicGen service on port $PORT"
echo "Model: $MUSICGEN_MODEL"
echo "Output: $MUSICGEN_OUTPUT_DIR"
echo ""
echo "First run downloads the model (~3GB) — subsequent starts are fast."
echo ""

uvicorn app:app --host 0.0.0.0 --port "$PORT"
