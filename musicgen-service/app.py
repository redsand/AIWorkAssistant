import os
import io
import uuid
import base64
import logging
import threading
from contextlib import asynccontextmanager

import torch
import torchaudio
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

generation_lock = threading.Lock()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("musicgen")

ALLOWED_MODELS = [
    "facebook/musicgen-small",
    "facebook/musicgen-medium",
    "facebook/musicgen-large",
    "facebook/musicgen-melody",
]

DEFAULT_MODEL = os.environ.get("MUSICGEN_MODEL", "facebook/musicgen-small")
MAX_DURATION = int(os.environ.get("MUSICGEN_MAX_DURATION", "60"))
OUTPUT_DIR = os.environ.get("MUSICGEN_OUTPUT_DIR", "/app/generated-audio")
DEVICE = os.environ.get("MUSICGEN_DEVICE", "auto")  # auto | cpu | cuda

# Cache of loaded models — avoid reloading on every request
_model_cache: dict = {}
_current_model_name: str = ""


def resolve_device() -> str:
    if DEVICE == "cpu":
        return "cpu"
    if DEVICE == "cuda":
        return "cuda" if torch.cuda.is_available() else "cpu"
    # auto: use GPU only if it has enough VRAM (>= 3GB), else CPU
    if torch.cuda.is_available():
        vram_mb = torch.cuda.get_device_properties(0).total_memory / 1024 / 1024
        log.info(f"GPU VRAM: {vram_mb:.0f} MB")
        if vram_mb >= 3000:
            return "cuda"
        log.warning(f"GPU has only {vram_mb:.0f} MB VRAM — using CPU for reliable generation")
    return "cpu"


def load_model(model_name: str):
    global _current_model_name
    if model_name in _model_cache:
        log.info(f"Using cached model: {model_name}")
        return _model_cache[model_name]

    device = resolve_device()
    log.info(f"Loading model: {model_name} on {device}")
    from audiocraft.models import MusicGen
    m = MusicGen.get_pretrained(model_name, device=device)
    _model_cache[model_name] = m
    _current_model_name = model_name
    log.info(f"Model loaded — device: {next(m.lm.parameters()).device}")
    return m


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    load_model(DEFAULT_MODEL)
    yield
    _model_cache.clear()


app = FastAPI(title="MusicGen Service", lifespan=lifespan)


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    duration_seconds: int = Field(default=15, ge=5, le=60)
    genre: str | None = None
    key: str | None = None
    tempo: int | None = None
    model: str | None = Field(default=None, description="Model to use, e.g. facebook/musicgen-small")


class GenerateResponse(BaseModel):
    asset_id: str
    file_path: str
    audio_base64: str
    sample_rate: int
    duration: float
    model: str
    warnings: list[str]


@app.get("/health")
def health():
    loaded = list(_model_cache.keys())
    return {
        "status": "ok",
        "model_loaded": len(loaded) > 0,
        "active_model": _current_model_name or DEFAULT_MODEL,
        "loaded_models": loaded,
        "allowed_models": ALLOWED_MODELS,
    }


@app.get("/models")
def list_models():
    return {
        "allowed": ALLOWED_MODELS,
        "loaded": list(_model_cache.keys()),
        "default": DEFAULT_MODEL,
    }


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest):
    model_name = req.model or DEFAULT_MODEL

    if model_name not in ALLOWED_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model '{model_name}'. Allowed: {ALLOWED_MODELS}"
        )

    warnings: list[str] = []
    duration = min(req.duration_seconds, MAX_DURATION)

    # Build rich prompt from all musical parameters
    parts = []
    if req.genre:
        parts.append(req.genre)
    if req.key:
        parts.append(f"key of {req.key}")
    if req.tempo:
        parts.append(f"{req.tempo} BPM")
    parts.append(req.prompt)
    prompt = ", ".join(parts)

    log.info(f"Generating {duration}s with {model_name} — prompt: {prompt[:80]}")

    if not generation_lock.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="Generation already in progress. Try again shortly.")

    try:
        model = load_model(model_name)
        model.set_generation_params(duration=duration)

        with torch.no_grad():
            wav = model.generate([prompt])

        wav = wav[0].cpu()
        sample_rate = model.sample_rate
    finally:
        generation_lock.release()

    asset_id = f"gen_{uuid.uuid4().hex[:12]}"
    filename = f"{asset_id}.wav"
    file_path = os.path.join(OUTPUT_DIR, filename)
    torchaudio.save(file_path, wav, sample_rate)
    log.info(f"Saved: {file_path}")

    buf = io.BytesIO()
    torchaudio.save(buf, wav, sample_rate, format="wav")
    audio_base64 = base64.b64encode(buf.getvalue()).decode()

    return GenerateResponse(
        asset_id=asset_id,
        file_path=file_path,
        audio_base64=audio_base64,
        sample_rate=sample_rate,
        duration=duration,
        model=model_name,
        warnings=warnings,
    )
