# Musician Assistant - Python Worker (Optional)

## Overview

The Musician Assistant's advanced audio analysis and generation features can optionally be enhanced by a Python worker service. **The TypeScript application works fully without this worker**, using stub data and basic metadata extraction via ffprobe. The Python worker enables production-quality audio analysis, transcription, and generation when deployed.

## Why Python Worker is Optional

### Standalone Operation
The TypeScript application provides complete functionality without Python dependencies:
- ✅ Music theory tutoring
- ✅ Composition assistance
- ✅ Basic audio metadata extraction (via ffprobe)
- ✅ Mix and mastering feedback (deterministic algorithms)
- ✅ Text-to-music generation (mock/dry-run modes)
- ✅ Practice plan generation

### Enhanced Capabilities with Worker
When the Python worker is available, additional features become enabled:
- 🎵 Advanced spectral analysis (Essentia)
- 🎹 Audio-to-MIDI transcription (Basic Pitch)
- 🎼 Local text-to-music generation (MusicGen)
- 📊 Professional loudness measurement (LUFS, true peak)
- 🎚️ Stem separation (future feature)

### Architecture Benefits
- **Separation of Concerns**: Audio processing isolated from main application
- **Language-Appropriate Tools**: Python ML/audio libraries in Python, business logic in TypeScript
- **Independent Scaling**: Worker can scale separately for compute-intensive tasks
- **Optional Deployment**: Not all environments need advanced audio processing
- **Cost Optimization**: Production workers only where needed

---

## Recommended Capabilities

### 1. Essentia Feature Extraction

**Purpose**: Extract advanced musical and acoustic features from audio

**Features Provided**:
- Key and scale detection
- Tempo and beat tracking
- Spectral centroid, rolloff, flux
- MFCCs (Mel-Frequency Cepstral Coefficients)
- Bark bands and spectral analysis
- Onset detection
- Dynamic range and rhythm analysis

**Python Libraries**:
```python
pip install essentia-tensorflow
```

**Use Case**: Enhances audio analysis with ML-based feature detection

---

### 2. Basic Pitch Audio-to-MIDI Transcription

**Purpose**: Convert audio recordings to MIDI note data

**Features Provided**:
- Note pitch detection (e.g., "C4", "A#3")
- Note timing (start/end times)
- Note velocity (0-127)
- Confidence scores per note
- Optional chord detection
- Onset detection

**Python Libraries**:
```python
pip install basic-pitch
```

**Use Case**: Enables transcription analysis type, generates MIDI files from audio

---

### 3. MusicGen Local Generation

**Purpose**: Generate music from text descriptions locally

**Features Provided**:
- Text-to-music generation
- Controllable duration (up to 30s efficiently)
- Model variants: small, medium, large
- Stereo output support
- Reproducible generation (seed control)

**Python Libraries**:
```python
pip install torch torchaudio
pip install audiocraft  # Meta's MusicGen
```

**Hardware Requirements**:
- GPU recommended (NVIDIA with CUDA)
- Minimum 8GB RAM (16GB+ recommended)
- Storage: ~2-8GB per model variant

**Use Case**: Enables local text-to-music generation without external API dependencies

---

### 4. LUFS/True Peak Measurement

**Purpose**: Professional loudness measurement for mastering analysis

**Features Provided**:
- Integrated LUFS (Loudness Units Full Scale)
- Loudness Range (LRA)
- True Peak in dBTP (prevents inter-sample peaks)
- Short-term and momentary loudness
- Compliance checking (broadcast, streaming standards)

**Python Libraries** (Option 1 - pyloudnorm):
```python
pip install pyloudnorm
```

**Python Libraries** (Option 2 - ffmpeg-python with ebur128):
```python
pip install ffmpeg-python
# Requires ffmpeg built with --enable-libebur128
```

**Use Case**: Accurate loudness measurement for mastering feedback

---

### 5. Stem Separation (Future Feature)

**Purpose**: Separate audio into individual instrument stems

**Features Provided** (planned):
- Vocal extraction
- Drum isolation
- Bass separation
- Other instruments
- Configurable output stems

**Python Libraries** (planned):
```python
pip install demucs
# or
pip install spleeter
```

**Use Case**: Enable detailed per-instrument analysis and mixing feedback

---

## API Contract

The Python worker exposes a simple REST API that the TypeScript application calls when advanced features are requested.

### Base URL
```
http://localhost:8001  # Default, configurable via MUSICIAN_WORKER_URL
```

### Authentication
- **Local deployments**: No authentication (worker bound to localhost only)
- **Production deployments**: Shared secret via `X-Worker-Auth` header

### Endpoints

#### 1. Health Check

**Request**:
```http
GET /health
```

**Response**:
```json
{
  "status": "healthy",
  "capabilities": {
    "essentia": true,
    "basic_pitch": true,
    "musicgen": true,
    "loudness": true,
    "stem_separation": false
  },
  "version": "1.0.0"
}
```

**Purpose**: Check worker availability and enabled features

---

#### 2. Audio Analysis

**Request**:
```http
POST /analyze
Content-Type: multipart/form-data

audio: <binary audio file>
features: ["essentia", "loudness"]
```

**Response**:
```json
{
  "duration_seconds": 180.5,
  "sample_rate": 44100,
  "channels": 2,
  "essentia": {
    "key": "C major",
    "scale": "major",
    "tempo": 128.5,
    "beats": [
      { "time": 0.0, "position": 1 },
      { "time": 0.468, "position": 2 }
    ],
    "spectral_centroid": 2500.0,
    "spectral_rolloff": 8000.0,
    "zcr": 0.045,
    "mfcc": [[...], [...]]
  },
  "loudness": {
    "integrated_lufs": -14.2,
    "loudness_range": 8.5,
    "true_peak_dbtp": -1.2,
    "short_term_lufs": [-15.1, -14.8, -13.9],
    "momentary_lufs": [-16.2, -15.5, -14.1]
  },
  "warnings": []
}
```

**Error Response** (422):
```json
{
  "error": "Invalid audio file",
  "details": "Could not decode audio. Supported formats: wav, mp3, flac, m4a"
}
```

**Parameters**:
- `audio`: Binary audio file (multipart upload)
- `features`: Array of feature extractors to run (optional, default: all available)

**Max File Size**: 100MB (configurable via `MAX_UPLOAD_SIZE`)

**Timeout**: 120 seconds for analysis

---

#### 3. Audio Transcription

**Request**:
```http
POST /transcribe
Content-Type: multipart/form-data

audio: <binary audio file>
confidence_threshold: 0.5
```

**Response**:
```json
{
  "notes": [
    {
      "pitch": "C4",
      "start_time": 0.0,
      "end_time": 0.5,
      "velocity": 80,
      "confidence": 0.92
    },
    {
      "pitch": "E4",
      "start_time": 0.5,
      "end_time": 1.0,
      "velocity": 75,
      "confidence": 0.88
    }
  ],
  "chords": [
    {
      "chord": "Cmaj",
      "start_time": 0.0,
      "end_time": 2.0,
      "confidence": 0.85
    }
  ],
  "midi_path": "/tmp/transcription_abc123.mid",
  "warnings": [
    "Low confidence in some note detections (< 0.7)"
  ]
}
```

**Parameters**:
- `audio`: Binary audio file
- `confidence_threshold`: Minimum confidence for note detection (0-1, default: 0.5)

**Output**:
- `midi_path`: Temporary path to generated MIDI file (deleted after 1 hour)

---

#### 4. Music Generation

**Request**:
```http
POST /generate
Content-Type: application/json

{
  "prompt": "upbeat electronic dance music with synth leads",
  "duration_seconds": 15,
  "temperature": 1.0,
  "top_k": 250,
  "top_p": 0.0,
  "model": "small",
  "seed": 12345
}
```

**Response**:
```json
{
  "audio_path": "/tmp/generated_xyz789.wav",
  "duration_seconds": 15.0,
  "sample_rate": 32000,
  "channels": 1,
  "model": "facebook/musicgen-small",
  "seed": 12345,
  "generation_time_seconds": 8.5,
  "warnings": []
}
```

**Parameters**:
- `prompt`: Text description of desired music (required)
- `duration_seconds`: Length in seconds (5-30, default: 15)
- `temperature`: Sampling temperature (0.0-2.0, default: 1.0)
- `top_k`: Top-k sampling (default: 250)
- `top_p`: Top-p nucleus sampling (default: 0.0)
- `model`: Model size - "small", "medium", "large" (default: "small")
- `seed`: Random seed for reproducibility (optional)

**Output**:
- `audio_path`: Temporary path to generated WAV file (deleted after 1 hour)

**Resource Limits**:
- Max duration: 30 seconds (configurable)
- GPU memory: Varies by model (2GB small, 4GB medium, 8GB large)
- Concurrent generations: 1 (queued if busy)

---

## Security Considerations

### 1. Network Isolation

**Default Configuration**:
```python
# Worker binds to localhost only
app.run(host="127.0.0.1", port=8001)
```

**Production Configuration**:
```python
# If deploying on separate server, use firewall rules
# to restrict access to TypeScript app only
```

### 2. File Size Limits

**Environment Variables**:
```bash
MAX_UPLOAD_SIZE=104857600  # 100MB in bytes
MAX_GENERATION_DURATION=30  # seconds
```

**Implementation**:
```python
@app.before_request
def check_content_length():
    if request.content_length and request.content_length > MAX_UPLOAD_SIZE:
        abort(413, "File too large")
```

### 3. Temporary Directory Cleanup

**Automatic Cleanup**:
```python
import tempfile
import atexit
import shutil

temp_dir = tempfile.mkdtemp(prefix="musician_worker_")

# Clean up on exit
atexit.register(lambda: shutil.rmtree(temp_dir, ignore_errors=True))

# Also run periodic cleanup
@app.route("/cleanup", methods=["POST"])
def cleanup_old_files():
    # Remove files older than 1 hour
    cutoff = time.time() - 3600
    for f in os.listdir(temp_dir):
        path = os.path.join(temp_dir, f)
        if os.path.getmtime(path) < cutoff:
            os.remove(path)
```

### 4. No Arbitrary Command Execution

**Prohibited**:
```python
# NEVER do this:
import subprocess
subprocess.run(request.json["command"], shell=True)  # ❌ DANGEROUS
```

**Safe Approach**:
```python
# Only call known, validated commands with sanitized inputs
import subprocess

ALLOWED_COMMANDS = {
    "analyze": ["/usr/bin/python", "/app/analyze.py"],
    "transcribe": ["/usr/bin/python", "/app/transcribe.py"],
}

def run_safe_command(command_type, args):
    if command_type not in ALLOWED_COMMANDS:
        raise ValueError("Invalid command type")

    # Validate and sanitize args
    safe_args = validate_args(args)

    # Run with timeout
    subprocess.run(
        ALLOWED_COMMANDS[command_type] + safe_args,
        timeout=120,
        check=True
    )
```

### 5. Input Validation

**File Type Validation**:
```python
ALLOWED_AUDIO_FORMATS = {".wav", ".mp3", ".flac", ".m4a", ".aac"}

def validate_audio_file(file):
    # Check extension
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_AUDIO_FORMATS:
        raise ValueError(f"Unsupported format: {ext}")

    # Check magic bytes
    import magic
    mime = magic.from_buffer(file.read(2048), mime=True)
    file.seek(0)
    if not mime.startswith("audio/"):
        raise ValueError("File is not audio")
```

### 6. Rate Limiting

**Request Rate Limits**:
```python
from flask_limiter import Limiter

limiter = Limiter(
    app,
    default_limits=["100 per hour", "20 per minute"]
)

@app.route("/generate", methods=["POST"])
@limiter.limit("5 per hour")  # Expensive operation
def generate():
    pass
```

### 7. Resource Limits

**Memory and CPU Limits** (Docker):
```yaml
services:
  musician-worker:
    deploy:
      resources:
        limits:
          cpus: "4.0"
          memory: 8G
        reservations:
          memory: 2G
```

---

## Installation Examples

### Option 1: Local Installation

**Prerequisites**:
```bash
# Python 3.9+
python --version

# pip and virtualenv
pip install virtualenv
```

**Setup**:
```bash
# Create virtual environment
cd python-worker
virtualenv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Install optional dependencies
pip install essentia-tensorflow  # For Essentia
pip install basic-pitch          # For transcription
pip install torch torchaudio     # For MusicGen
pip install audiocraft            # Meta's MusicGen
pip install pyloudnorm           # For loudness measurement

# For GPU support (NVIDIA)
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

**Run Worker**:
```bash
# Development mode
python worker.py

# Production mode (with gunicorn)
pip install gunicorn
gunicorn -w 2 -b 127.0.0.1:8001 worker:app
```

**Environment Variables**:
```bash
export MUSICIAN_WORKER_PORT=8001
export MAX_UPLOAD_SIZE=104857600
export MAX_GENERATION_DURATION=30
export TEMP_DIR=/tmp/musician-worker
export LOG_LEVEL=INFO
```

---

### Option 2: Docker Container

**Dockerfile**:
```dockerfile
FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY worker.py .
COPY analyze.py .
COPY transcribe.py .
COPY generate.py .

# Create temp directory
RUN mkdir -p /tmp/musician-worker

# Non-root user
RUN useradd -m -u 1000 worker && chown -R worker:worker /app /tmp/musician-worker
USER worker

# Expose port
EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8001/health')"

# Run worker
CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:8001", "--timeout", "120", "worker:app"]
```

**Build and Run**:
```bash
# Build image
docker build -t musician-worker:latest .

# Run container (CPU only)
docker run -d \
  --name musician-worker \
  -p 127.0.0.1:8001:8001 \
  -e MAX_UPLOAD_SIZE=104857600 \
  -e MAX_GENERATION_DURATION=30 \
  musician-worker:latest

# Run container (with GPU support)
docker run -d \
  --name musician-worker \
  --gpus all \
  -p 127.0.0.1:8001:8001 \
  -e MAX_UPLOAD_SIZE=104857600 \
  -e MAX_GENERATION_DURATION=30 \
  musician-worker:latest
```

---

### Option 3: Docker Compose (Future Extension)

**docker-compose.yml**:
```yaml
version: '3.8'

services:
  # Main TypeScript application
  ai-assistant:
    build: .
    ports:
      - "3000:3000"
    environment:
      - MUSICIAN_WORKER_URL=http://musician-worker:8001
      - MUSICIAN_ENABLE_ESSENTIA=true
      - MUSICIAN_ENABLE_BASIC_PITCH=true
      - MUSICIAN_ENABLE_MUSICGEN=true
    depends_on:
      musician-worker:
        condition: service_healthy
    networks:
      - internal

  # Python worker for audio processing
  musician-worker:
    build: ./python-worker
    ports:
      - "127.0.0.1:8001:8001"  # Only expose to localhost
    environment:
      - MAX_UPLOAD_SIZE=104857600
      - MAX_GENERATION_DURATION=30
      - LOG_LEVEL=INFO
    volumes:
      - worker-temp:/tmp/musician-worker
    deploy:
      resources:
        limits:
          cpus: "4.0"
          memory: 8G
        reservations:
          memory: 2G
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8001/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - internal
    restart: unless-stopped

volumes:
  worker-temp:

networks:
  internal:
    driver: bridge
```

**Usage**:
```bash
# Start all services
docker-compose up -d

# Check worker status
docker-compose exec musician-worker curl http://localhost:8001/health

# View logs
docker-compose logs -f musician-worker

# Stop all services
docker-compose down
```

**Production Scaling**:
```yaml
services:
  musician-worker:
    deploy:
      replicas: 3  # Run 3 worker instances
      update_config:
        parallelism: 1
        delay: 10s
      restart_policy:
        condition: on-failure
        max_attempts: 3
```

---

## TypeScript Application Configuration

### Environment Variables

**Enable Worker Features**:
```bash
# Worker endpoint
MUSICIAN_WORKER_URL=http://localhost:8001

# Feature flags (set to "true" to enable)
MUSICIAN_ENABLE_ESSENTIA=true
MUSICIAN_ENABLE_BASIC_PITCH=true
MUSICIAN_ENABLE_MUSICGEN=true

# Generation provider selection
MUSICIAN_GENERATION_PROVIDER=local_musicgen  # or "mock", "huggingface"

# Fallback behavior
MUSICIAN_WORKER_TIMEOUT=30000  # milliseconds
MUSICIAN_WORKER_RETRY_ATTEMPTS=2
```

### Worker Client (TypeScript)

**Example Implementation**:
```typescript
// src/integrations/audio/worker-client.ts

interface WorkerHealth {
  status: string;
  capabilities: {
    essentia: boolean;
    basic_pitch: boolean;
    musicgen: boolean;
    loudness: boolean;
  };
  version: string;
}

export class MusicianWorkerClient {
  private baseUrl: string;
  private timeout: number;

  constructor() {
    this.baseUrl = process.env.MUSICIAN_WORKER_URL || 'http://localhost:8001';
    this.timeout = parseInt(process.env.MUSICIAN_WORKER_TIMEOUT || '30000');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getCapabilities(): Promise<WorkerHealth['capabilities']> {
    const response = await fetch(`${this.baseUrl}/health`);
    const health: WorkerHealth = await response.json();
    return health.capabilities;
  }

  async analyze(audioPath: string, features: string[]): Promise<any> {
    const formData = new FormData();
    formData.append('audio', fs.createReadStream(audioPath));
    formData.append('features', JSON.stringify(features));

    const response = await fetch(`${this.baseUrl}/analyze`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`Worker analysis failed: ${response.statusText}`);
    }

    return response.json();
  }
}
```

---

## Fallback Behavior When Worker Unavailable

### Graceful Degradation Strategy

The TypeScript application handles worker unavailability transparently:

#### 1. Feature Detection at Startup

```typescript
// src/musician/service.ts

export class MusicianService {
  private workerClient: MusicianWorkerClient;
  private capabilities: WorkerCapabilities;

  async initialize() {
    this.workerClient = new MusicianWorkerClient();

    // Check worker availability
    const isAvailable = await this.workerClient.isAvailable();

    if (isAvailable) {
      this.capabilities = await this.workerClient.getCapabilities();
      logger.info('Musician worker available', this.capabilities);
    } else {
      this.capabilities = {
        essentia: false,
        basic_pitch: false,
        musicgen: false,
        loudness: false,
      };
      logger.warn('Musician worker unavailable - using fallback mode');
    }
  }
}
```

#### 2. Conditional Feature Execution

```typescript
async analyzeAudio(request: AudioAnalysisRequest): Promise<AudioAnalysisResult> {
  const warnings: string[] = [];

  // Always extract basic metadata via ffprobe
  const metadata = await extractBasicMetadata(request.filePath);

  // Try advanced analysis if worker available
  if (this.capabilities.essentia) {
    try {
      const essentiaData = await this.workerClient.analyze(
        request.filePath,
        ['essentia']
      );
      metadata.keyEstimate = essentiaData.essentia.key;
      metadata.tempoBpm = essentiaData.essentia.tempo;
    } catch (error) {
      warnings.push('Essentia analysis failed - using metadata only');
    }
  } else {
    warnings.push(
      'Essentia not available. Install Python worker for advanced analysis.'
    );
  }

  // Generate report with available data
  return {
    metrics: metadata,
    report: generateReport(metadata, request.analysisType),
    warnings,
    confidence: this.capabilities.essentia ? 0.9 : 0.5,
  };
}
```

#### 3. User-Visible Warnings

**In UI Results**:
```
⚠️ Warnings:
- Essentia analysis not available. Install Python worker for key detection and tempo analysis.
- Basic Pitch transcription not available. Install Python worker for audio-to-MIDI conversion.

Using basic metadata extraction only. Analysis confidence: 50%
```

**In API Responses**:
```json
{
  "metrics": { "durationSeconds": 180.5, "sampleRate": 44100 },
  "report": "...",
  "warnings": [
    "Essentia not available - key and tempo detection disabled",
    "Using ffprobe metadata only"
  ],
  "confidence": 0.5
}
```

#### 4. Generation Mode Fallback

```typescript
async generateMusic(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
  // Check provider preference
  const provider = request.modelPreference || process.env.MUSICIAN_GENERATION_PROVIDER;

  if (provider === 'local_musicgen') {
    if (!this.capabilities.musicgen) {
      // Fallback to mock mode
      return new MockMusicGenerationProvider().generate(request);
    }

    // Use worker for generation
    const result = await this.workerClient.generate({
      prompt: request.prompt,
      duration_seconds: request.durationSeconds,
      model: 'small',
    });

    return this.convertWorkerResult(result);
  }

  // Use mock or other providers
  return new MockMusicGenerationProvider().generate(request);
}
```

#### 5. Health Check Monitoring

```typescript
// Periodic health checks
setInterval(async () => {
  const wasAvailable = this.workerAvailable;
  this.workerAvailable = await this.workerClient.isAvailable();

  if (wasAvailable && !this.workerAvailable) {
    logger.error('Musician worker became unavailable');
    // Optionally notify admins
  } else if (!wasAvailable && this.workerAvailable) {
    logger.info('Musician worker became available');
    // Refresh capabilities
    this.capabilities = await this.workerClient.getCapabilities();
  }
}, 60000); // Check every minute
```

---

## Testing Without Worker

### Unit Tests

```typescript
describe('MusicianService without worker', () => {
  it('should analyze audio with metadata only', async () => {
    // Mock worker as unavailable
    const service = new MusicianService();
    service.capabilities = { essentia: false, basic_pitch: false };

    const result = await service.analyzeAudio({
      filePath: 'test.wav',
      analysisType: 'mixdown',
    });

    expect(result.warnings).toContain('Essentia not available');
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('should generate music in mock mode when worker unavailable', async () => {
    const service = new MusicianService();
    service.capabilities = { musicgen: false };

    const result = await service.generateMusic({
      prompt: 'upbeat electronic',
      durationSeconds: 15,
    });

    expect(result.model).toBe('mock-v1');
    expect(result.warnings).toContain('Mock mode');
  });
});
```

### Integration Tests

```typescript
describe('Worker fallback integration', () => {
  it('should handle worker timeout gracefully', async () => {
    // Simulate slow/unresponsive worker
    const service = new MusicianService();

    // Should timeout and fallback to basic analysis
    const result = await service.analyzeAudio({
      filePath: 'test.wav',
      analysisType: 'all',
    });

    expect(result.warnings.some(w => w.includes('timeout'))).toBe(true);
  });
});
```

---

## Deployment Checklist

### Development Environment
- [ ] TypeScript app runs without worker
- [ ] Mock generation works for dry-run testing
- [ ] Basic metadata extraction via ffprobe works
- [ ] UI shows appropriate warnings when features unavailable

### Staging Environment (with Worker)
- [ ] Python worker installed and running
- [ ] Worker health endpoint responds
- [ ] All capabilities enabled and working
- [ ] TypeScript app detects and uses worker features
- [ ] Fallback still works if worker stopped

### Production Environment
- [ ] Worker deployed with resource limits
- [ ] Network isolation configured (localhost or firewall)
- [ ] File size limits enforced
- [ ] Temporary directory cleanup scheduled
- [ ] Monitoring and alerting configured
- [ ] GPU available for generation (if enabled)
- [ ] Graceful degradation tested

---

## Summary

The Python worker is an **optional enhancement** that enables production-quality audio analysis and generation. The TypeScript application:

✅ **Works completely without the worker** using stub data and basic metadata
✅ **Detects worker availability** at startup and runtime
✅ **Falls back gracefully** when worker is unavailable
✅ **Provides clear warnings** to users about limited functionality
✅ **Scales independently** for compute-intensive tasks

**Key Environment Variables**:
```bash
MUSICIAN_WORKER_URL=http://localhost:8001
MUSICIAN_ENABLE_ESSENTIA=true
MUSICIAN_ENABLE_BASIC_PITCH=true
MUSICIAN_ENABLE_MUSICGEN=true
MUSICIAN_GENERATION_PROVIDER=local_musicgen
```

**No worker implementation is required** - this document serves as a specification for future implementation or third-party integration.
