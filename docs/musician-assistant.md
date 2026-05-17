# Musician Assistant / Guide - Architecture Document

## 1. Product Goals

The Musician Assistant is a first-class domain module that provides comprehensive music theory, composition, and production guidance through an AI-powered personal assistant. It serves as a virtual music teacher,arranger, and production partner for musicians of all levels.

**Primary Objectives:**

1. **Music Theory Education**: Provide interactive explanations, exercises, and quizzes on music theory concepts (scales, chords, harmony, rhythm, form, etc.)

2. **Songwriting & Composition**: Help users write songs through guided exercises, chord progression suggestions, melody ideas, and lyrical brainstorming

3. **Arrangement Feedback**: Analyze and provide feedback on instrument arrangements, voicings, and overall song structure

4. **Text-to-Music Generation**: Generate audio samples from text prompts using AI music generation models

5. **Audio Upload Analysis**: Analyze user-uploaded audio files to identify key, tempo, structure, instruments, and provide improvement suggestions

6. **Mixdown Feedback**: Provide objective and subjective feedback on audio mixing decisions

7. **Mastering Feedback**: Offer guidance on mastering decisions for final production

8. **Instrument-Specific Coaching**: Provide practice plans, technique exercises, and repertoire suggestions for specific instruments

9. **Project Memory**: Maintain session notes, follow-ups, and track musical ideas over time

**Target Users:**
- Solo musicians and singer-songwriters
- Band members looking for arrangement ideas
- Producers and engineers seeking feedback
- Music students and educators
- Hobbyists learning music theory

---

## 2. Non-Goals

These are explicitly out of scope for the initial implementation and future iterations unless specifically called out:

1. **Direct Audio Streaming/Playback**: This assistant will not control music streaming services (Spotify, Apple Music, etc.). It may provide links to streaming platforms but will not play audio directly.

2. **Digital Audio Workstation (DAW) Integration**: Direct control of DAWs (Ableton, Logic, Pro Tools, FL Studio, etc.) is out of scope. Feedback is provided in text form for user implementation.

3. **Commercial Music Distribution**: Will not handle music distribution to streaming services or physical media.

4. **Legal Services**: Will not provide legal advice on copyright, publishing, or performance rights.

5. **Real-time Audio Processing**: No real-time audio effects or live performance tools.

6. **Synthesizer Control**: Will not directly control hardware or software synthesizers.

7. **Band Member Collaboration**: Not a collaborative DAW or real-time jamming platform.

8. **Music Notation Generation**: Will not generate sheet music or tablature. May describe musical concepts textually.

9. **Audio Recording**: Will not record audio from microphones or instruments.

10. **Hardware Recommendations**: Will not provide detailed recommendations for purchasing music gear (though it may suggest general approaches).

---

## 3. User Workflows

### 3.1 Learning Workflow
```
User asks: "Explain how dominant seventh chords work"
  ↓
Assistant provides:
  - Theory explanation (what it is, why it's used)
  - Examples in common keys
  - Interactive exercise: "Try building a dominant seventh on E"
  ↓
User completes exercise
  ↓
Assistant provides feedback and next step
```

### 3.2 Songwriting Workflow
```
User asks: "Help me write a song in the key of G major"
  ↓
Assistant guides through:
  - Chord progression suggestions (I-IV-V, ii-V-I, etc.)
  - Verse/chorus structure ideas
  - Melodic contour suggestions
  - Lyrical themes and brainstorming
  ↓
User provides素材 (lyrics, melody, etc.)
  ↓
Assistant provides arrangement and feedback
```

### 3.3 Audio Analysis Workflow
```
User uploads: "Analyze this recording"
  ↓
Assistant processes:
  - Key detection (via audio analysis tool)
  - Tempo detection
  - Structure identification (verse, chorus, bridge)
  - Instrument identification
  - Feedback on performance and arrangement
  ↓
User receives actionable feedback
```

### 3.4 Practice Workflow
```
User asks: "I practice guitar, help me improve my fingerpicking"
  ↓
Assistant creates:
  - Specific exercises targeting fingerpicking
  - Practice schedule (daily/weekly)
  - Progress tracking and milestones
  - Repertoire suggestions matching current skill
  ↓
User practices and logs progress
  ↓
Assistant provides feedback and adjusts plan
```

### 3.5 Production Feedback Workflow
```
User uploads: "Here's my mix - what do you think?"
  ↓
Assistant analyzes:
  - Frequency balance (bass, mids, highs)
  - Dynamic range and compression
  - Stereo imaging
  - Levels and panning
  - Objectives vs subjective suggestions
  ↓
User receives:
  - Measurable observations (dB levels, frequency issues)
  - Creative suggestions (arrangement changes, effect ideas)
```

---

## 4. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Fastify Server                            │
│                           src/server.ts                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Routes (src/routes/)                       │  │
│  │  ┌────────────────────────────────────────────────────────┐   │  │
│  │  │  src/routes/music.ts                                    │   │  │
│  │  │  - POST /music/analyze                                  │   │  │
│  │  │  - POST /music/generate                                 │   │  │
│  │  │  - POST /music/session                                  │   │  │
│  │  │  - GET  /music/session/:id                              │   │  │
│  │  │  - GET  /music/memory                                   │   │  │
│  │  └────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         v                           v                           v
┌────────────────┐        ┌────────────────────────┐    ┌────────────────────────┐
│  Music Domain  │        │  Agent Integration     │    │  External Integrations   │
│  src/music/    │        │  src/agent/            │    │  src/integrations/       │
│                │        │                        │    │                        │
│  player.ts     │        │  prompts.ts            │    │  music/                  │
│  composer.ts   │        │  tool-registry.ts      │    │  ├── music-client.ts     │
│  arranger.ts   │        │  tool-dispatcher.ts      │    │  └── music-service.ts    │
│  analyzer.ts   │        │                        │    │                        │
│  practice.ts   │        │  → Add MUSIC_TOOLS     │    │  → Add music.* prefix  │
│  memory.ts     │        │  → Add music.*         │    │  → Audio processing    │
│  feedback.ts   │        │     actionType         │    │     (Python workers)     │
│  types.ts      │        │  → Add musician.*      │    │  └── text-to-music     │
│                │        │     namespace          │    │        (Python workers)  │
│                │        │                        │    │  └── audio-analyzer    │
└────────────────┘        └────────────────────────┘    │     (Python workers)     │
                                                        │                        │
                                                        │  └────────────────────────┘
                                                        │
                                                        v
┌─────────────────────────────────────────────────────────────────────┐
│                      Policy & Approval System                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  src/policy/engine.ts                                         │  │
│  │  - Evaluates music.* actions                                   │  │
│  │  - Approval queue for generated files/analysis                │  │
│  │  - Guardrails for sensitive operations                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Domain Structure

```
src/music/
├── types.ts              # TypeScript interfaces
├── player.ts             # Music playback (non-streaming, local)
├── composer.ts           # Songwriting guidance
├── arranger.ts           # Arrangement feedback
├── analyzer.ts           # Audio analysis
├── practice.ts           # Practice planning and coaching
├── feedback.ts           # Mix/mastering feedback
├── memory.ts             # Session notes and follow-ups
└── generator.ts          # Text-to-music generation interface
```

### Integration Structure

```
src/integrations/music/
├── music-client.ts       # Base API client (extensible)
├── music-service.ts      # Policy-gated service layer
└── audio/                # Audio processing utilities
    ├── processor.ts      # File handling and analysis
    └── converters.ts     # Format conversions
```

---

## 5. Data Model

### Core Types (`src/music/types.ts`)

```typescript
// Session-related types
export interface MusicSession {
  id: string;
  userId: string;
  type: 'learning' | 'composition' | 'arrangement' | 'production' | 'practice';
  title: string;
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'completed' | 'archived';
}

export interface SessionNote {
  id: string;
  sessionId: string;
  type: 'idea' | 'observation' | 'action' | 'feedback' | 'review';
  content: string;
  priority?: 'low' | 'medium' | 'high';
  createdAt: string;
  followUpAt?: string;
}

// Analysis result types
export interface AudioAnalysis {
  id: string;
  userId: string;
  fileId: string;
  fileName: string;
  duration: number; // seconds
  key: string; // detected key (e.g., "C", "Am", "G major")
  tempo: number; // BPM
  structure: Array<{
    section: 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro' | 'instrumental';
    start: number; // seconds
    end: number; // seconds
  }>;
  instruments: string[]; // detected instruments
  recommendations: Array<{
    type: 'arrangement' | 'performance' | 'technical';
    description: string;
    priority: 'low' | 'medium' | 'high';
  }>;
  createdAt: string;
}

// Generated music metadata
export interface GeneratedMusic {
  id: string;
  userId: string;
  prompt: string;
  model: string; // e.g., "suno-v3", "audio-craft"
  seed: number;
  duration: number; // seconds
  tempo?: number;
  key?: string;
  genre?: string;
  filePath: string;
  sha256: string;
  license: 'personal' | 'commercial' | 'restricted';
  createdAt: string;
}

// Practice types
export interface PracticeSession {
  id: string;
  userId: string;
  instrument: string;
  focus: string;
  duration: number; // minutes
  exercises: PracticeExercise[];
  completed: boolean;
  completedAt?: string;
  rating?: number; // 1-5
  notes?: string;
}

export interface PracticeExercise {
  name: string;
  description: string;
  tempo?: number;
  repeats: number;
  completed: boolean;
}

// Feedback types
export interface MixFeedback {
  id: string;
  userId: string;
  analysisId: string;
  frequencyBalance: {
    bass: number; // -10 to +10 dB relative to reference
    mids: number;
    highs: number;
  };
  dynamics: {
    compression: string; // descriptive assessment
    limiting: string;
    loudness: number; // LUFS
  };
  stereo: {
    width: number; // 0-100%
    panning: 'balanced' | 'left-heavy' | 'right-heavy';
  };
  levelBalance: Record<string, number>; // track name to level
  measurableIssues: Array<{
    type: 'frequency' | 'dynamic' | 'stereo' | 'level';
    severity: 'minor' | 'moderate' | 'major';
    description: string;
  }>;
  creativeSuggestions: Array<{
    type: 'arrangement' | 'effect' | 'mix';
    description: string;
  }>;
  createdAt: string;
}
```

### Database Schema (File-based)

The app uses file-based storage (JSON) for persistence. Sessions and notes are stored in user-specific directories.

**Storage Paths:**
- `data/users/{userId}/music/sessions/*.json` - Music sessions
- `data/users/{userId}/music/notes/*.json` - Session notes
- `data/users/{userId}/music/analyzer/*.json` - Audio analysis results
- `data/users/{userId}/music/generation/*.json` - Generated music metadata
- `data/users/{userId}/music/practice/*.json` - Practice session records
- `data/users/{userId}/music/feedback/*.json` - Mix/mastering feedback

---

## 6. API Endpoints

All endpoints are registered via `src/routes/music.ts` and prefixed with `/api/music`.

### 6.1 Analysis Endpoints

| Method | Endpoint | Description | Risk Level |
|--------|----------|-------------|------------|
| POST | `/api/music/analyze/upload` | Analyze uploaded audio file | medium |
| POST | `/api/music/analyze/description` | Generate text description of audio | low |
| GET | `/api/music/analyze/:id` | Get analysis result | low |
| GET | `/api/music/analyze/user/:userId` | List user's analyses | low |

### 6.2 Generation Endpoints

| Method | Endpoint | Description | Risk Level |
|--------|----------|-------------|------------|
| POST | `/api/music/generate/text` | Generate music from text prompt | medium |
| POST | `/api/music/generate/text:dry-run` | Preview text-to-music generation | low |
| GET | `/api/music/generation/:id` | Get generated music info | low |
| GET | `/api/music/generations/user/:userId` | List user's generations | low |

### 6.3 Session & Memory Endpoints

| Method | Endpoint | Description | Risk Level |
|--------|----------|-------------|------------|
| POST | `/api/music/session` | Create new music session | low |
| GET | `/api/music/session/:id` | Get session details | low |
| GET | `/api/music/session/user/:userId` | List user's sessions | low |
| PATCH | `/api/music/session/:id` | Update session | medium |
| DELETE | `/api/music/session/:id` | Archive session | medium |
| POST | `/api/music/session/:id/note` | Add session note | low |
| GET | `/api/music/session/:id/notes` | Get session notes | low |

### 6.4 Practice Endpoints

| Method | Endpoint | Description | Risk Level |
|--------|----------|-------------|------------|
| POST | `/api/music/practice` | Create practice plan | low |
| GET | `/api/music/practice/user/:userId` | List practice plans | low |
| POST | `/api/music/practice/:id/start` | Mark practice as started | low |
| POST | `/api/music/practice/:id/complete` | Mark practice as complete | medium |
| GET | `/api/music/practice/:id/exercises` | Get practice exercises | low |
| GET | `/api/music/practice/instrument/:instrument` | Get instrument-specific exercises | low |

### 6.5 Feedback Endpoints

| Method | Endpoint | Description | Risk Level |
|--------|----------|-------------|------------|
| POST | `/api/music/feedback/mix` | Request mixdown feedback | medium |
| POST | `/api/music/feedback/master` | Request mastering feedback | medium |
| GET | `/api/music/feedback/:id` | Get feedback result | low |
| GET | `/api/music/feedback/user/:userId` | List user's feedback requests | low |

### 6.6 Learning Endpoints

| Method | Endpoint | Description | Risk Level |
|--------|----------|-------------|------------|
| GET | `/api/music/theory/:concept` | Get theory explanation | low |
| POST | `/api/music/exercise` | Generate theory exercise | low |
| POST | `/api/music/exercise/submit` | Submit exercise answer | low |
| GET | `/api/music/exercise/:id/results` | Get exercise results | low |

### Request/Response Examples

**Audio Analysis Request:**
```http
POST /api/music/analyze/upload
Content-Type: multipart/form-data

file: <audio file>
userId: "user123"
context: "acoustic guitar recording"
```

**Mix Feedback Request:**
```http
POST /api/music/feedback/mix
Content-Type: application/json

{
  "userId": "user123",
  "audioId": "audio-456",
  "options": {
    "analyzeFrequency": true,
    "analyzeDynamics": true,
    "analyzeStereo": true
  }
}
```

**Practice Plan Request:**
```http
POST /api/music/practice
Content-Type: application/json

{
  "userId": "user123",
  "instrument": "guitar",
  "focus": "fingerpicking",
  "duration": 30,
  "level": "intermediate",
  "weeklySessions": 4
}
```

---

## 7. Tool Namespace Design (`musician.*`)

### Tool Naming Convention

Tools will use the `musician.*` prefix, with action patterns following `musician.[category].[action]`.

**Existing Prefix Map in `tool-registry.ts`:**
```typescript
const PLATFORM_PREFIX_MAP: Record<string, Platform> = {
  // ... existing entries
  musician: 'cross-platform',
};
```

### Tool Categories and Definitions

**`src/agent/tool-registry.ts` - MUSICIAN_TOOLS:**

```typescript
const MUSICIAN_TOOLS: Tool[] = [
  // Learning tools
  {
    name: "musician.explain_theory",
    description: "Explain music theory concepts interactively",
    params: {
      concept: { type: "string", description: "Theory concept to explain", required: true },
      context: { type: "string", description: "User's musical context (instrument, level)", required: false },
      examples: { type: "boolean", description: "Include examples", required: false },
      interactive: { type: "boolean", description: "Include interactive exercises", required: false },
    },
    actionType: "musician.learning.theory",
    riskLevel: "low",
  },
  {
    name: "musician.generate_exercise",
    description: "Generate music theory exercises",
    params: {
      type: { type: "string", description: "Exercise type: scales, chords, rhythm, ear_training", required: true },
      difficulty: { type: "string", description: "Difficulty: beginner, intermediate, advanced", required: true },
      instrument: { type: "string", description: "Target instrument", required: false },
    },
    actionType: "musician.learning.exercise",
    riskLevel: "low",
  },

  // Composition tools
  {
    name: "musician.compose_chord_progression",
    description: "Generate chord progressions in a given key",
    params: {
      key: { type: "string", description: "Key (e.g., 'C', 'Am', 'G major')", required: true },
      style: { type: "string", description: "Style: pop, rock, jazz, classical, etc.", required: false },
      complexity: { type: "string", description: "Complexity: simple, moderate, advanced", required: false },
    },
    actionType: "musician.composition.chord_progression",
    riskLevel: "low",
  },
  {
    name: "musician.arrange_song",
    description: "Provide arrangement feedback for a song",
    params: {
      songDescription: { type: "string", description: "Description of song structure", required: true },
      arrangementFocus: { type: "string", description: "What to focus on: voicings, texture, dynamics", required: false },
    },
    actionType: "musician.arrangement.feedback",
    riskLevel: "low",
  },

  // Audio analysis tools
  {
    name: "musician.analyze_audio",
    description: "Analyze uploaded audio file for key, tempo, structure",
    params: {
      fileId: { type: "string", description: "Uploaded file ID", required: true },
      analyzeKey: { type: "boolean", description: "Detect key", required: false },
      analyzeTempo: { type: "boolean", description: "Detect tempo", required: false },
      analyzeStructure: { type: "boolean", description: "Identify sections", required: false },
    },
    actionType: "musician.analysis.audio",
    riskLevel: "medium",
  },

  // Generation tools
  {
    name: "musician.generate_music",
    description: "Generate music from text prompt using AI model",
    params: {
      prompt: { type: "string", description: "Text description of desired music", required: true },
      model: { type: "string", description: "Model: suno-v3, audio-craft, etc.", required: false },
      duration: { type: "number", description: "Duration in seconds", required: false },
      dryRun: { type: "boolean", description: "Preview without generation", required: false },
    },
    actionType: "musician.generation.audio",
    riskLevel: "medium",
  },

  // Production tools
  {
    name: "musician.feedback_mix",
    description: "Analyze mixdown and provide feedback",
    params: {
      audioId: { type: "string", description: "Audio file ID", required: true },
      focus: { type: "string", description: "Focus areas: frequency, dynamics, stereo", required: false },
    },
    actionType: "musician.production.mix",
    riskLevel: "medium",
  },
  {
    name: "musician.feedback_master",
    description: "Analyze mastered track and provide feedback",
    params: {
      audioId: { type: "string", description: "Mastered audio file ID", required: true },
    },
    actionType: "musician.production.master",
    riskLevel: "medium",
  },

  // Practice tools
  {
    name: "musician.practice_plan",
    description: "Create practice plan for instrument",
    params: {
      instrument: { type: "string", description: "Instrument to practice", required: true },
      focus: { type: "string", description: "Focus area", required: true },
      duration: { type: "number", description: "Available practice time in minutes", required: false },
    },
    actionType: "musician.practice.plan",
    riskLevel: "low",
  },
  {
    name: "musician.practice_exercise",
    description: "Generate specific practice exercise",
    params: {
      exerciseType: { type: "string", description: "Type: scales, arpeggios, rhythm, technique", required: true },
      instrument: { type: "string", description: "Instrument", required: false },
    },
    actionType: "musician.practice.exercise",
    riskLevel: "low",
  },

  // Memory tools
  {
    name: "musician.session_note",
    description: "Add note to current music session",
    params: {
      content: { type: "string", description: "Note content", required: true },
      type: { type: "string", description: "Note type: idea, observation, action, feedback", required: false },
      followUpAt: { type: "string", description: "ISO date for follow-up", required: false },
    },
    actionType: "musician.memory.note",
    riskLevel: "low",
  },
  {
    name: "musician.session_summary",
    description: "Get summary of current music session",
    params: {
      sessionId: { type: "string", description: "Session ID", required: true },
    },
    actionType: "musician.memory.summary",
    riskLevel: "low",
  },
];
```

### Tool Dispatch Handlers (`src/agent/tool-dispatcher.ts`)

```typescript
import { musicianService } from "../integrations/music/music-service";

async function handleMusicianAnalyzeAudio(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const fileId = params.fileId as string;
  if (!fileId) return { success: false, error: "fileId is required" };

  const result = await musicianService.analyzeAudio(fileId);
  return { success: true, data: result };
}

async function handleMusicianGenerateMusic(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const prompt = params.prompt as string;
  if (!prompt) return { success: false, error: "prompt is required" };

  const result = await musicianService.generateMusic(
    prompt,
    params as GenerateMusicParams,
  );
  return { success: true, data: result };
}

async function handleMusicianFeedbackMix(
  params: Record<string, unknown>,
): Promise<ToolCallResult> {
  const audioId = params.audioId as string;
  if (!audioId) return { success: false, error: "audioId is required" };

  const result = await musicianService.analyzeMix(audioId);
  return { success: true, data: result };
}
```

---

## 8. Audio-Processing Pipeline

### Architecture Overview

Audio processing will be handled by Python-based worker scripts that communicate with the TypeScript main app via file-based message passing. This approach is used because:

1. **Python has superior audio libraries**: Librosa, audioread, essentia, and others are more mature than JavaScript equivalents
2. **Computational intensity**: Audio analysis (pitch detection, STFT, MFCC) is CPU-intensive and benefits from Python's optimized libraries
3. **Existing Python infrastructure**: Many music AI models are Python-based

### Pipeline Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Audio Processing Pipeline                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  1. File Upload (TypeScript)                                        │
│     └── src/routes/music.ts: POST /api/music/analyze/upload         │
│         └── Saves file to data/users/{userId}/audio/uploads/       │
│                                                                       │
│  2. Job Queue (TypeScript)                                          │
│     └── Creates analysis job record                                  │
│         └── data/users/{userId}/audio/jobs/{jobId}.json             │
│                                                                       │
│  3. Worker Trigger (TypeScript)                                     │
│     └── Forks Python subprocess or sends to queue                   │
│                                                                       │
│  4. Analysis Worker (Python)                                        │
│     └── src/integrations/music/audio/worker.py                      │
│         ├── Detect key (YIN or Autocorrelation)                     │
│         ├── Detect tempo (Beat tracking)                            │
│         ├── Detect structure (Chroma features)                      │
│         ├── Identify instruments (Classification model)             │
│         └── Generate recommendations                                │
│                                                                       │
│  5. Result Storage (TypeScript)                                     │
│     └── Save analysis to data/users/{userId}/music/analyzer/        │
│                                                                       │
│  6. User Notification (TypeScript)                                  │
│     └── Websocket/SSE notification or email                         │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Python Worker Script (`src/integrations/music/audio/worker.py`)

```python
#!/usr/bin/env python3
"""
Audio analysis worker - processes uploaded audio files and generates analysis results.
This script is called by the TypeScript app via subprocess.
"""

import argparse
import json
import os
import sys
import tempfile
import librosa
import numpy as np
from pathlib import Path

# Analysis imports
from essentia.standard import (
    MonoLoader,
    RhythmExtractor2013,
    KeyExtractor,
    TonalityExtractor,
    KeyEstimator,
    SilenceRate,
    EST
)

def load_audio(filepath: str, sample_rate: int = 22050):
    """Load audio file using librosa."""
    y, sr = librosa.load(filepath, sr=sample_rate, mono=True)
    return y, sr

def detect_key(y, sr):
    """Detect the key of the audio."""
    # Use multiple methods and combine
    key, scale = KeyExtractor()(y)
    return {"key": key, "scale": scale}

def detect_tempo(y, sr):
    """Detect tempo using beat tracking."""
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    return {"tempo": float(tempo), "bpm": int(tempo)}

def detect_structure(y, sr):
    """Detect song sections (verse, chorus, etc.)."""
    # Compute chroma features
    chroma = librosa.feature.chroma_stft(y=y, sr=sr)

    # Beat-synchronous chroma
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(tempo)
    beats = librosa.beat.beat_track(y=y, sr=sr)[1]

    # Simple segmentation (this would be expanded with ML model in production)
    # This detects sections by finding chroma pattern changes
    chroma_sync = librosa.feature.sync(chroma, beats)
    diff = np.diff(chroma_sync, prepend=0)
    section_boundaries = np.where(np.abs(diff) > 0.5)[0]

    # Convert to time
    beat_times = librosa.frames_to_time(beats, sr=sr)
    sections = []
    for i in range(len(section_boundaries) - 1):
        start_idx = section_boundaries[i]
        end_idx = section_boundaries[i + 1]
        if end_idx < len(beat_times):
            sections.append({
                "start": float(beat_times[start_idx]),
                "end": float(beat_times[end_idx]),
                "type": "unknown"
            })

    return {"sections": sections}

def identify_instruments(y, sr):
    """Estimate instruments present in the audio."""
    # Spectral features for instrument classification
    spectral_centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
    spectral_bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr)
    spectral_rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr)

    # Rhythm features
    onset_strength = librosa.onset.onset_strength(y=y, sr=sr)
    percussive = librosa.effects.percussive(y)
    harmonic = librosa.effects.harmonic(y)

    # Simple heuristic-based instrument detection
    instruments = []

    # Bass detection (low frequency energy)
    bass_freq = librosa.filter_banks(n_freqs=256, n_filters=1, fmin=20, fmax=200, sr=sr)
    if np.mean(bass_freq) > 0.5:
        instruments.append("bass")

    # Drums detection (percussive content)
    if np.mean(onset_strength) > 0.1:
        instruments.append("drums")

    # Guitar/Vocal detection (mid frequencies)
    if np.mean(spectral_centroid) < 1000:
        if np.mean(harmonic) > np.mean(percussive):
            instruments.append("vocals")
        else:
            instruments.append("guitar")

    # Piano detection (broad frequency range)
    if np.mean(spectral_bandwidth) > 500 and np.mean(spectral_centroid) > 300:
        instruments.append("piano")

    return {"instruments": list(set(instruments))}

def generate_recommendations(analysis):
    """Generate feedback based on analysis results."""
    recommendations = []

    # Key-based recommendations
    if analysis.get('key', {}).get('key'):
        key = analysis['key']['key']
        recommendations.append({
            "type": "key_suggestion",
            "description": f"Key of {key} detected. Consider using related keys for modulation.",
            "priority": "low"
        })

    # Tempo-based recommendations
    if analysis.get('tempo', {}).get('tempo'):
        tempo = analysis['tempo']['tempo']
        if tempo < 60:
            recommendations.append({
                "type": "tempo_feedback",
                "description": "Very slow tempo. Consider adding more rhythmic variety.",
                "priority": "medium"
            })
        elif tempo > 160:
            recommendations.append({
                "type": "tempo_feedback",
                "description": "Fast tempo. Check for timing issues in complex passages.",
                "priority": "medium"
            })

    return recommendations

def main():
    parser = argparse.ArgumentParser(description='Audio Analysis Worker')
    parser.add_argument('--input', required=True, help='Input audio file path')
    parser.add_argument('--output', required=True, help='Output JSON file path')
    parser.add_argument('--job-id', required=True, help='Job ID for tracking')

    args = parser.parse_args()

    # Load audio
    y, sr = load_audio(args.input)

    # Run analysis
    analysis = {
        "job_id": args.job_id,
        "key": detect_key(y, sr),
        "tempo": detect_tempo(y, sr),
        "structure": detect_structure(y, sr),
        "instruments": identify_instruments(y, sr),
    }

    # Generate recommendations
    analysis["recommendations"] = generate_recommendations(analysis)

    # Save results
    with open(args.output, 'w') as f:
        json.dump(analysis, f, indent=2)

    print(f"Analysis complete for job {args.job_id}")

if __name__ == "__main__":
    main()
```

### TypeScript Service Layer (`src/integrations/music/music-service.ts`)

```typescript
import { spawn } from "child_process";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";
import { policyEngine } from "../policy/engine";
import type { AudioAnalysis } from "../../music/types";

export class MusicService {
  async analyzeAudio(fileId: string, userId: string): Promise<AudioAnalysis> {
    const action = {
      id: Date.now().toString(),
      type: "musician.analysis.audio",
      description: `Analyze audio file ${fileId}`,
      params: { fileId },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);
    if (!decision.result.allow) {
      throw new Error(`Policy error: ${decision.reason}`);
    }

    // Find the uploaded file
    const uploadPath = this.getUserAudioPath(userId, fileId);
    if (!(await this.fileExists(uploadPath))) {
      throw new Error(`File not found: ${fileId}`);
    }

    // Create job record
    const jobId = uuidv4();
    const jobPath = join(this.getUserAudioPath(userId, "jobs"), `${jobId}.json`);
    await writeFile(jobPath, JSON.stringify({
      jobId,
      fileId,
      status: "pending",
      createdAt: new Date().toISOString(),
    }, null, 2));

    // Spawn Python worker
    const resultPath = join(this.getUserAudioPath(userId, "results"), `${jobId}.json`);

    return new Promise((resolve, reject) => {
      const workerPath = join(__dirname, "audio", "worker.py");
      const python = spawn("python3", [workerPath, "--input", uploadPath, "--output", resultPath, "--job-id", jobId]);

      let stderr = "";
      python.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      python.on("close", async (code) => {
        if (code !== 0) {
          reject(new Error(`Python worker failed with code ${code}: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(await readFile(resultPath, "utf-8"));
          resolve({
            id: jobId,
            userId,
            fileId,
            fileName: fileId,
            duration: 0, // Would need to extract from audio
            key: result.key?.key || "Unknown",
            tempo: result.tempo?.bpm || 0,
            structure: result.structure?.sections || [],
            instruments: result.instruments?.instruments || [],
            recommendations: result.recommendations || [],
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private getUserAudioPath(userId: string, ...paths: string[]) {
    return join(env.USER_DATA_PATH || "data/users", userId, "audio", ...paths);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  }
}

export const musicService = new MusicService();
```

### Integration with Main App (`src/routes/music.ts`)

```typescript
import { FastifyInstance } from "fastify";
import { musicService } from "../integrations/music/music-service";
import type { AudioAnalysis } from "../music/types";

export async function musicRoutes(fastify: FastifyInstance) {
  // Upload and analyze audio
  fastify.post("/music/analyze/upload", async (request, reply) => {
    const { userId } = request.body as { userId: string };

    // Handle file upload (multipart/form-data)
    const parts = request.parts();
    const part = await parts();

    if (!part || part.type !== "file") {
      reply.code(400);
      return { success: false, error: "No file uploaded" };
    }

    // Save file
    const fileId = `audio_${Date.now()}`;
    const filePath = join(
      env.USER_DATA_PATH || "data/users",
      userId,
      "audio",
      "uploads",
      fileId
    );

    // Save part to file system
    // ... file saving logic ...

    // Trigger analysis
    const analysis = await musicService.analyzeAudio(fileId, userId);

    return { success: true, analysis };
  });
}
```

---

## 9. Music-Generation Pipeline

### Text-to-Music Architecture

Text-to-music generation will use external AI models via API calls. The architecture supports multiple providers with an adapter pattern.

### Provider Adapters (`src/integrations/music/generation/`)

```
src/integrations/music/generation/
├── adapter.ts          # Base adapter interface
├── suno.ts             # Suno (AI music generation) adapter
├── audiocraft.ts       # Meta's AudioCraft adapter
└── generative.ts       # Generic generator interface
```

### Adapter Interface

```typescript
export interface MusicGeneratorAdapter {
  readonly name: string;
  readonly description: string;
  readonly supportedFeatures: string[];

  generate(prompt: string, options: GenerateOptions): Promise<GeneratedMusic>;
  validatePrompt(prompt: string): boolean;
  getCostEstimate(duration: number): number;
}
```

### Suno Adapter Example (`src/integrations/music/generation/suno.ts`)

```typescript
import axios, { AxiosInstance } from "axios";
import { env } from "../../config/env";
import type { GeneratedMusic } from "../../../music/types";

export interface SunoOptions {
  prompt: string;
  duration?: number;
  model?: "suno-v3" | "suno-v3.5" | "suno-v5";
  lyrics?: string;
  style?: string;
  title?: string;
}

export class SunoGenerator {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.SUNO_API_URL || "https://api.suno.ai/v1",
      headers: {
        "Authorization": `Bearer ${env.SUNO_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
  }

  isConfigured(): boolean {
    return !!env.SUNO_API_KEY;
  }

  async generate(options: SunoOptions): Promise<GeneratedMusic> {
    const response = await this.client.post("/generate", {
      prompt: options.prompt,
      duration: options.duration,
      model: options.model || "suno-v3",
      lyrics: options.lyrics,
      style: options.style,
      title: options.title,
    });

    const { clip_id, audio_url, thumbnail_url } = response.data;

    return {
      id: clip_id,
      userId: options.userId || "anonymous",
      prompt: options.prompt,
      model: options.model || "suno-v3",
      seed: Math.floor(Math.random() * 1000000),
      duration: options.duration || 30,
      filePath: audio_url,
      sha256: this.generateHash(audio_url),
      license: "personal",
      createdAt: new Date().toISOString(),
    };
  }

  private generateHash(url: string): string {
    // Generate deterministic hash from URL
    // Implementation details...
    return "hash_placeholder";
  }
}

export const sunoGenerator = new SunoGenerator();
```

### Main Generator Service

```typescript
import { sunoGenerator } from "./suno";
import { audiocraftGenerator } from "./audiocraft";
import type { GeneratedMusic } from "../../music/types";

export class MusicGenerationService {
  async generateMusic(
    prompt: string,
    options: { model?: string; duration?: number; dryRun?: boolean }
  ): Promise<GeneratedMusic> {
    if (options.dryRun) {
      return {
        id: "dry-run-123",
        userId: "anonymous",
        prompt: prompt,
        model: options.model || "suno-v3",
        seed: 0,
        duration: options.duration || 30,
        filePath: "dry-run-preview.mp3",
        sha256: "dry-run-hash",
        license: "personal",
        createdAt: new Date().toISOString(),
      };
    }

    // Select generator based on model preference
    let generator;
    if (options.model?.includes("suno") && sunoGenerator.isConfigured()) {
      generator = sunoGenerator;
    } else if (options.model?.includes("audiocraft") && audiocraftGenerator.isConfigured()) {
      generator = audiocraftGenerator;
    } else {
      // Default to first configured generator
      if (sunoGenerator.isConfigured()) {
        generator = sunoGenerator;
      } else {
        throw new Error("No music generation API configured");
      }
    }

    const result = await generator.generate({
      prompt,
      duration: options.duration,
    });

    // Store metadata
    await this.storeGenerationMetadata(result);

    return result;
  }

  private async storeGenerationMetadata(generation: GeneratedMusic): Promise<void> {
    // Save to database/file system
    // Implementation details...
  }
}

export const generationService = new MusicGenerationService();
```

### API Endpoint (`src/routes/music.ts`)

```typescript
import { generationService } from "../integrations/music/generation/generation-service";

fastify.post("/music/generate/text", async (request, reply) => {
  const { prompt, model, duration, userId } = request.body as {
    prompt: string;
    model?: string;
    duration?: number;
    userId: string;
  };

  if (!prompt) {
    reply.code(400);
    return { success: false, error: "prompt is required" };
  }

  try {
    const result = await generationService.generateMusic(prompt, {
      model,
      duration,
      dryRun: false,
    });
    return { success: true, generation: result };
  } catch (error) {
    reply.code(500);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Generation failed",
    };
  }
});
```

---

## 10. Mix/Mastering Feedback Pipeline

### Analysis Architecture

Mix and mastering feedback combines algorithmic analysis with AI-powered interpretation. The system provides both **measurable observations** (objective data) and **creative suggestions** (subjective recommendations).

### Feedback Service (`src/music/feedback.ts`)

```typescript
import type { MixFeedback, MasteringFeedback } from "./types";

export class FeedbackService {
  /**
   * Analyze mixdown and provide feedback
   */
  async analyzeMix(
    audioId: string,
    options?: {
      analyzeFrequency?: boolean;
      analyzeDynamics?: boolean;
      analyzeStereo?: boolean;
    }
  ): Promise<MixFeedback> {
    // 1. Load audio analysis (if already analyzed)
    const analysis = await this.getAudioAnalysis(audioId);

    // 2. Perform frequency analysis
    const frequencyBalance = options?.analyzeFrequency !== false
      ? await this.analyzeFrequencyBalance(audioId)
      : { bass: 0, mids: 0, highs: 0 };

    // 3. Analyze dynamics
    const dynamics = options?.analyzeDynamics !== false
      ? await this.analyzeDynamics(audioId)
      : { compression: "unknown", limiting: "unknown", loudness: 0 };

    // 4. Analyze stereo imaging
    const stereo = options?.analyzeStereo !== false
      ? await this.analyzeStereo(audioId)
      : { width: 50, panning: "balanced" };

    // 5. Calculate level balance
    const levelBalance = await this.analyzeLevelBalance(audioId);

    // 6. Generate measurable issues
    const measurableIssues = this.identifyMeasurableIssues(
      frequencyBalance,
      dynamics,
      stereo,
      levelBalance
    );

    // 7. Generate creative suggestions
    const creativeSuggestions = this.generateCreativeSuggestions(
      measurableIssues,
      audioId
    );

    const result: MixFeedback = {
      id: `feedback_${Date.now()}`,
      audioId,
      frequencyBalance,
      dynamics,
      stereo,
      levelBalance,
      measurableIssues,
      creativeSuggestions,
      createdAt: new Date().toISOString(),
    };

    // Store result
    await this.saveFeedback(result);

    return result;
  }

  /**
   * Mastering feedback (simplified - focuses on final loudness and clarity)
   */
  async analyzeMaster(audioId: string): Promise<MasteringFeedback> {
    const mixFeedback = await this.analyzeMix(audioId, {
      analyzeFrequency: true,
      analyzeDynamics: true,
      analyzeStereo: true,
    });

    const masteringAssessment = {
      loudnessTarget: this.assessLoudnessTarget(mixFeedback.dynamics.loudness),
      clarity: this.assessClarity(mixFeedback.frequencyBalance),
      stereoImage: this.assessStereoImage(mixFeedback.stereo.width),
      dynamicRange: this.assessDynamicRange(mixFeedback.dynamics),
    };

    return {
      id: `master_${Date.now()}`,
      mixFeedback,
      masteringAssessment,
      recommendations: this.generateMasteringRecommendations(
        masteringAssessment
      ),
      createdAt: new Date().toISOString(),
    };
  }

  // --- Analysis Methods ---

  private async analyzeFrequencyBalance(audioId: string): Promise<{
    bass: number;
    mids: number;
    highs: number;
  }> {
    // Load audio spectrum data from analysis
    // Compare to reference curves (Harman curve, etc.)
    // Return balanced dB offsets (-10 to +10 dB)
    return { bass: 0, mids: 0, highs: 0 };
  }

  private async analyzeDynamics(audioId: string): Promise<{
    compression: string;
    limiting: string;
    loudness: number; // LUFS
  }> {
    // Analyze dynamic range
    // Identify compression points
    // Measure loudness (LUFS)
    return {
      compression: "moderate",
      limiting: "heavy",
      loudness: -14, // Target LUFS for streaming
    };
  }

  private async analyzeStereo(audioId: string): Promise<{
    width: number; // 0-100%
    panning: "balanced" | "left-heavy" | "right-heavy";
  }> {
    // Analyze stereo image
    // Calculate left/right balance
    return { width: 75, panning: "balanced" };
  }

  private async analyzeLevelBalance(audioId: string): Promise<Record<string, number>> {
    // Analyze track levels
    // Return relative levels for each track
    return { kick: -6, snare: -6, bass: -8, vocals: -4, guitars: -10 };
  }

  private identifyMeasurableIssues(
    frequency: { bass: number; mids: number; highs: number },
    dynamics: { loudness: number },
    stereo: { width: number; panning: string },
    levels: Record<string, number>
  ): Array<{
    type: "frequency" | "dynamic" | "stereo" | "level";
    severity: "minor" | "moderate" | "major";
    description: string;
  }> {
    const issues: MixFeedback["measurableIssues"] = [];

    // Frequency issues
    if (Math.abs(frequency.bass) > 6) {
      issues.push({
        type: "frequency",
        severity: Math.abs(frequency.bass) > 10 ? "major" : "moderate",
        description: `Bass ${frequency.bass > 0 ? "excessive" : "lacking"} at ${frequency.bass.toFixed(1)}dB`,
      });
    }

    // Dynamic issues
    if (dynamics.loudness > -9) {
      issues.push({
        type: "dynamic",
        severity: "moderate",
        description: `Over-compressed - loudness at ${dynamics.loudness}LUFS may cause clipping`,
      });
    }

    // Level balance issues
    if (levels.vocals && levels.vocals > -2) {
      issues.push({
        type: "level",
        severity: "minor",
        description: `Vocals may be too loud (${levels.vocals}dB)`,
      });
    }

    return issues;
  }

  private generateCreativeSuggestions(
    issues: MixFeedback["measurableIssues"],
    audioId: string
  ): MixFeedback["creativeSuggestions"] {
    const suggestions: MixFeedback["creativeSuggestions"] = [];

    for (const issue of issues) {
      if (issue.type === "frequency" && issue.severity === "moderate") {
        suggestions.push({
          type: "effect",
          description: "Try a high-pass filter at 80-100Hz to clean up sub-bass",
        });
      }
      if (issue.type === "dynamic") {
        suggestions.push({
          type: "mix",
          description: "Consider reducing compression to preserve dynamics",
        });
      }
    }

    return suggestions;
  }
}

export const feedbackService = new FeedbackService();
```

### API Endpoints

```typescript
import { feedbackService } from "../music/feedback";

fastify.post("/music/feedback/mix", async (request, reply) => {
  const { audioId, options, userId } = request.body as {
    audioId: string;
    options?: {
      analyzeFrequency?: boolean;
      analyzeDynamics?: boolean;
      analyzeStereo?: boolean;
    };
    userId: string;
  };

  if (!audioId) {
    reply.code(400);
    return { success: false, error: "audioId is required" };
  }

  try {
    const result = await feedbackService.analyzeMix(audioId, options);
    return { success: true, feedback: result };
  } catch (error) {
    reply.code(500);
    return { success: false, error: error.message };
  }
});

fastify.post("/music/feedback/master", async (request, reply) => {
  const { audioId, userId } = request.body as {
    audioId: string;
    userId: string;
  };

  if (!audioId) {
    reply.code(400);
    return { success: false, error: "audioId is required" };
  }

  try {
    const result = await feedbackService.analyzeMaster(audioId);
    return { success: true, feedback: result };
  } catch (error) {
    reply.code(500);
    return { success: false, error: error.message };
  }
});
```

### Output Format

The feedback distinguishes between:

**Measurable Observations (Objective):**
- Frequency balance: dB offsets for bass/mids/highs
- Loudness: LUFS measurements
- Dynamic range: Ratio or k-weighted measurements
- Level balance: Relative dB levels per track

**Creative Suggestions (Subjective):**
- Arrangement ideas
- Effect chain suggestions
- Creative mixing techniques
- Reference track comparisons

---

## 11. Privacy, Safety, and Rights Considerations

### Audio File Privacy

| Aspect | Policy | Implementation |
|--------|--------|----------------|
| **Default Privacy** | All uploaded audio is private by default | Files stored in `data/users/{userId}/audio/` with no public access |
| **File Access** | Only the user and authorized agents can access files | Middleware check on all music routes |
| **File Deletion** | Files can be deleted by user request | `DELETE /api/music/audio/:fileId` endpoint |
| **Audit Trail** | All file access is logged | Audit logger in music service |

### Generated Content Rights

| Aspect | Policy | Implementation |
|--------|--------|----------------|
| **User Ownership** | User owns generated audio | Metadata tracks `userId` and `license: "personal"` |
| **Third-Party Models** | Generated content subject to provider terms | Metadata includes `model` and `license` fields |
| **Copyright Detection** | No automatic copyright scanning | Not implemented (out of scope) |
| **Commercial Use** |明确 license restrictions | `license` field: "personal" \| "commercial" \| "restricted" |

### AI Provider Considerations

**Provider Adapters Must Handle:**
1. **API Rate Limits**: Implement backoff and queuing
2. **Cost Tracking**: Log generation costs for budgeting
3. **Content Policy**: Filter harmful/pornographic content
4. **Copyright Compliance**: Not store generated music without proper licensing
5. **Data Retention**: Delete temporary files after processing

### Guardrails Implementation

```typescript
// src/guardrails/music-guardrails.ts
import { env } from "../config/env";

export const musicGuardrails = {
  /**
   * Check if audio file size is within limits
   */
  validateFileSize(filePath: string, maxSizeMB: number = 50): boolean {
    const size = fs.statSync(filePath).size;
    return size <= maxSizeMB * 1024 * 1024;
  },

  /**
   * Check if prompt contains prohibited content
   */
  validatePrompt(prompt: string): boolean {
    const prohibitedTerms = [
      // Copyrighted artist names (for direct imitation)
      ...env.PROHIBITED_ARTIST_NAMES?.split(",") || [],
      // Profanity
      ...env.PROFANITY_LIST?.split(",") || [],
    ];

    return !prohibitedTerms.some(term =>
      prompt.toLowerCase().includes(term.toLowerCase())
    );
  },

  /**
   * Check if generated content might infringe copyright
   */
  async checkCopyrightSimilarity(audioPath: string, referenceSet: string[]): Promise<boolean> {
    // Compare audio fingerprints against known copyrighted works
    // Returns true if content appears similar to protected works
    return false; // Simplified - implementation would use audio fingerprinting
  },

  /**
   * Rate limiting for music operations
   */
  rateLimitCheck(userId: string, operation: string): boolean {
    // Check rate limit counters
    // Returns true if within limits
    return true; // Implementation would check redis or file-based counters
  },
};
```

### Data Retention Policy

| Data Type | Retention Period | User Control |
|-----------|-----------------|--------------|
| Uploaded Audio | Until deletion | Delete endpoint + auto-cleanup after 90 days |
| Audio Analysis | 1 year | Delete via `/api/music/analyze/:id` |
| Generated Music | Indefinite (user-owned) | Delete via `/api/music/generation/:id` |
| Practice Sessions | 2 years | Archive/delete at any time |
| Session Notes | Indefinite | Delete per-note |

### GDPR/Privacy Compliance

- **Right to Access**: User can export all music data via `/api/music/export`
- **Right to Deletion**: Delete endpoints for all user data
- **Data Portability**: JSON export of all sessions and feedback

---

## 12. Testing Strategy

### Unit Tests (`test/music/`)

```typescript
// test/music/types.test.ts
import { describe, it, expect } from "vitest";
import type { AudioAnalysis, GeneratedMusic, MixFeedback } from "../../src/music/types";

describe("Music Types", () => {
  it("should validate AudioAnalysis structure", () => {
    const analysis: AudioAnalysis = {
      id: "test-123",
      userId: "user1",
      fileId: "audio-1",
      fileName: "test.mp3",
      duration: 180,
      key: "C",
      tempo: 120,
      structure: [],
      instruments: ["guitar", "vocals"],
      recommendations: [],
      createdAt: new Date().toISOString(),
    };
    expect(analysis.key).toBe("C");
  });

  it("should validate GeneratedMusic structure", () => {
    const generation: GeneratedMusic = {
      id: "gen-123",
      userId: "user1",
      prompt: "lofi hip hop beat",
      model: "suno-v3",
      seed: 12345,
      duration: 30,
      filePath: "generated/test.mp3",
      sha256: "abc123",
      license: "personal",
      createdAt: new Date().toISOString(),
    };
    expect(generation.license).toBe("personal");
  });
});
```

### Integration Tests (`test/integration/music/`)

```typescript
// test/integration/music/routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../../src/server";
import { env } from "../../src/config/env";

describe("Music API Routes", () => {
  let server: any;

  beforeAll(async () => {
    server = await buildServer();
    await server.listen({ port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it("should analyze audio file", async () => {
    const formData = new FormData();
    formData.append("userId", "test-user");
    // Add file...

    const response = await server.inject({
      method: "POST",
      url: "/api/music/analyze/upload",
      payload: formData,
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.payload);
    expect(result.success).toBe(true);
    expect(result.analysis).toHaveProperty("key");
  });

  it("should generate music from text", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/music/generate/text",
      payload: {
        prompt: "calm piano piece",
        userId: "test-user",
      },
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.payload);
    expect(result.success).toBe(true);
    expect(result.generation).toHaveProperty("filePath");
  });
});
```

### Python Worker Tests (`test/python/`)

```python
# test/python/worker_test.py
import unittest
import subprocess
import json
import os
import tempfile

class TestAudioWorker(unittest.TestCase):
    def test_analyze_audio(self):
        """Test audio analysis worker produces valid output"""
        # Create test audio file
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            test_input = f.name

        with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as f:
            test_output = f.name

        try:
            # Run worker
            result = subprocess.run([
                'python3', 'src/integrations/music/audio/worker.py',
                '--input', test_input,
                '--output', test_output,
                '--job-id', 'test-job'
            ], capture_output=True, text=True)

            self.assertEqual(result.returncode, 0)

            # Validate output
            with open(test_output) as f:
                output = json.load(f)

            self.assertIn('key', output)
            self.assertIn('tempo', output)
            self.assertIn('structure', output)
        finally:
            os.unlink(test_input)
            os.unlink(test_output)

if __name__ == '__main__':
    unittest.main()
```

### Test Coverage Targets

| Component | Target Coverage |
|-----------|-----------------|
| Type definitions | 100% |
| Feedback service | 90% |
| Generator service | 80% |
| API routes | 85% |
| Python workers | 70% |

---

## 13. Phased Implementation Plan

### Phase 1: Foundation (Weeks 1-2)

**Goal:** Establish core infrastructure and basic services

**Deliverables:**
- `src/music/types.ts` - All TypeScript interfaces
- `src/routes/music.ts` - Route handlers with minimal functionality
- `src/integrations/music/music-client.ts` - Base API client
- `docs/musician-assistant.md` - This document

**API Endpoints (Phase 1):**
- `POST /api/music/session` - Create session
- `GET /api/music/session/:id` - Get session
- `POST /api/music/session/:id/note` - Add note
- `GET /api/music/session/:id/notes` - Get notes

**Acceptance Criteria:**
- [ ] All TypeScript types defined
- [ ] Routes registered in server.ts
- [ ] Policy evaluation integrated
- [ ] Unit tests pass (70% coverage)

### Phase 2: Learning & Composition (Weeks 3-4)

**Goal:** Enable music theory and songwriting features

**Deliverables:**
- `src/music/composer.ts` - Songwriting guidance
- `src/music/practice.ts` - Practice planning
- `src/music/memory.ts` - Session memory management
- `src/agent/prompts.ts` - MUSIC_SYSTEM_PROMPT
- `src/agent/tool-registry.ts` - MUSICIAN_TOOLS
- `src/agent/tool-dispatcher.ts` - Tool handlers

**API Endpoints (Phase 2 additions):**
- `POST /api/music/exercise` - Generate exercise
- `POST /api/music/exercise/submit` - Submit answer
- `GET /api/music/theory/:concept` - Get theory explanation
- `POST /api/music/practice` - Create practice plan
- `GET /api/music/practice/user/:userId` - List practice plans

**Acceptance Criteria:**
- [ ] System prompt includes musician mode
- [ ] All musician.* tools registered
- [ ] Tools dispatch correctly
- [ ] Practice plan generation working

### Phase 3: Audio Analysis (Weeks 5-6)

**Goal:** Implement audio file upload and analysis

**Deliverables:**
- `src/integrations/music/audio/worker.py` - Python analysis worker
- `src/integrations/music/audio/processor.ts` - File handling
- `src/music/analyzer.ts` - Analysis service
- File upload endpoint integration

**API Endpoints (Phase 3 additions):**
- `POST /api/music/analyze/upload` - Upload and analyze audio
- `GET /api/music/analyze/:id` - Get analysis
- `GET /api/music/analyze/user/:userId` - List analyses

**Acceptance Criteria:**
- [ ] File upload works with multipart/form-data
- [ ] Python worker processes audio correctly
- [ ] Key/tempo/structure detection working
- [ ] Analysis stored in user's data directory

### Phase 4: Music Generation (Week 7)

**Goal:** Implement text-to-music generation

**Deliverables:**
- `src/integrations/music/generation/` - Generator adapters
- `src/integrations/music/generation/suno.ts` - Suno adapter
- `src/integrations/music/generation/generation-service.ts` - Generator service
- Configuration for AI music providers

**API Endpoints (Phase 4 additions):**
- `POST /api/music/generate/text` - Generate music from text
- `POST /api/music/generate/text:dry-run` - Preview generation

**Acceptance Criteria:**
- [ ] At least one music generation API configured
- [ ] Text-to-music generation working
- [ ] Generated files stored with metadata
- [ ] Dry-run mode functional

### Phase 5: Production Feedback (Weeks 8-9)

**Goal:** Implement mix and mastering feedback

**Deliverables:**
- `src/music/feedback.ts` - Feedback service
- Frequency analysis implementation
- Dynamics analysis implementation
- Stereo analysis implementation

**API Endpoints (Phase 5 additions):**
- `POST /api/music/feedback/mix` - Mix feedback
- `POST /api/music/feedback/master` - Mastering feedback
- `GET /api/music/feedback/:id` - Get feedback

**Acceptance Criteria:**
- [ ] Measurable issues identified
- [ ] Creative suggestions generated
- [ ] Feedback stored with analysis
- [ ] Output distinguishes objective vs subjective

### Phase 6: Advanced Features (Weeks 10-11)

**Goal:** Implement advanced capabilities

**Deliverables:**
- Arrangement feedback
- Instrument-specific coaching
- Practice progress tracking
- Session summarization

**API Endpoints (Phase 6 additions):**
- `POST /api/music/arrange/feedback` - Arrangement feedback
- `GET /api/music/practice/instrument/:instrument` - Instrument exercises
- `POST /api/music/session/:id/summarize` - Summarize session

**Acceptance Criteria:**
- [ ] Arrangement feedback meaningful
- [ ] Practice tracking functional
- [ ] Session notes aggregated correctly

### Phase 7: Polish & Documentation (Week 12)

**Goal:** Final quality improvements and documentation

**Deliverables:**
- Comprehensive API documentation
- User guides
- Architecture diagram updates
- Performance optimization

**Acceptance Criteria:**
- [ ] All endpoints documented
- [ ] Error handling comprehensive
- [ ] Logging adequate
- [ ] Performance benchmarks met

---

## Implementation: TypeScript vs Python

### TypeScript Implementation (Recommended)

**Use TypeScript for:**
1. **All domain logic** (`src/music/`)
   - Business rules and calculations
   - Session management
   - Memory and follow-ups
   - Practice planning algorithms

2. **API routes** (`src/routes/music.ts`)
   - Fastify route handlers
   - Request validation
   - Authentication checks

3. **Service layer** (`src/integrations/music/`)
   - Policy-gated access
   - User authorization
   - File system management

4. **Agent integration**
   - Tool definitions
   - Tool dispatch handlers
   - System prompts

### Python Implementation (Optional/Supplemental)

**Use Python for:**
1. **Audio analysis workers**
   - Key detection (YIN, autocorrelation)
   - Beat tracking and tempo detection
   - Spectral analysis
   - Music information retrieval

2. **Machine learning models**
   - Instrument classification
   - Structural segmentation
   - Reference comparison

3. **Heavy computation**
   - STFT and feature extraction
   - Audio fingerprinting

**Rationale:** Python has superior audio libraries (librosa, essentia, madmom) that are more mature than JavaScript equivalents. The TypeScript app calls Python workers via subprocess and passes data via files.

### Hybrid Architecture Benefits

```
┌────────────────────────────────────────────────────────────────┐
│                         TypeScript (Main)                        │
│  - Fastify server                                                │
│  - Business logic                                                │
│  - API routes                                                    │
│  - File management                                               │
│  - Policy enforcement                                            │
└────────────────────────────┬───────────────────────────────────┘
                             │
                             │ Subprocess calls + file I/O
                             ▼
┌────────────────────────────────────────────────────────────────┐
│                          Python (Workers)                       │
│  - Audio analysis                                                │
│  - Feature extraction                                            │
│  - ML inference                                                  │
│  - Heavy computation                                             │
└────────────────────────────────────────────────────────────────┘
```

### File-Based Communication

**Input (TypeScript → Python):**
```typescript
// Write job request to file
const jobPath = `data/audio/jobs/${jobId}.json`;
await writeFile(jobPath, JSON.stringify({
  filePath: inputAudioPath,
  jobId,
  options,
}));
```

**Output (Python → TypeScript):**
```typescript
// Read result from file
const resultPath = `data/audio/results/${jobId}.json`;
const result = JSON.parse(await readFile(resultPath, 'utf8'));
```

This approach:
- Decouples the two systems
- Allows workers to run independently
- Provides audit trail
- Simplifies error handling

---

## Initial File Structure

```
src/
├── music/                           # NEW: Music domain module
│   ├── types.ts                     # NEW: TypeScript interfaces
│   ├── player.ts                    # NEW: Player logic
│   ├── composer.ts                  # NEW: Songwriting guidance
│   ├── arranger.ts                  # NEW: Arrangement feedback
│   ├── analyzer.ts                  # NEW: Audio analysis
│   ├── practice.ts                  # NEW: Practice planning
│   ├── feedback.ts                  # NEW: Mix/mastering feedback
│   ├── memory.ts                    # NEW: Session memory
│   └── generator.ts                 # NEW: Text-to-music interface
├── integrations/
│   └── music/                       # NEW: Music integration
│       ├── music-client.ts          # NEW: Base API client
│       ├── music-service.ts         # NEW: Policy-gated service
│       └── audio/                   # NEW: Audio utilities
│           └── worker.py            # NEW: Audio analysis worker
├── agent/
│   ├── prompts.ts                   # MODIFIED: Add MUSIC_SYSTEM_PROMPT
│   ├── tool-registry.ts             # MODIFIED: Add MUSICIAN_TOOLS
│   └── tool-dispatcher.ts           # MODIFIED: Add handler functions
└── routes/
    └── music.ts                     # NEW: Fastify routes

test/
├── music/                           # NEW: Unit tests
├── integration/                     # NEW: Integration tests
└── python/                          # NEW: Python worker tests
```

---

*Document Version: 1.0*
*Last Updated: 2026-05-15*
