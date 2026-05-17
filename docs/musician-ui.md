# Musician Assistant Web UI

## Overview

The Musician Assistant provides a comprehensive web interface for music-related tasks including music theory education, composition assistance, audio analysis, text-to-music generation, and practice planning.

## Access

- **URL**: `http://localhost:3000/musician` (or your deployed URL)
- **Navigation**: Accessible from the main app header (🎵 icon) or the Capabilities page

## Features

### 1. Theory Tutor
Learn music theory concepts with interactive examples and exercises.

**Fields:**
- Topic (required): e.g., "dominant seventh chords", "circle of fifths"
- Skill Level: beginner, intermediate, advanced, professional
- Instrument (optional): e.g., "piano", "guitar"
- Music Style (optional): e.g., "jazz", "rock"
- Include exercises checkbox
- Include examples checkbox

**API Endpoint**: `POST /api/musician/theory`

### 2. Composition Assistant
Get help with songwriting, chord progressions, and arrangement.

**Fields:**
- Goal (required): e.g., "write a chorus", "create a bridge"
- Genre (optional): e.g., "pop", "rock", "jazz"
- Mood (optional): e.g., "uplifting", "melancholic"
- Key (optional): e.g., "C major", "Am"
- Tempo (optional): BPM value
- Output Format: markdown, lead sheet, chord chart, arrangement plan

**API Endpoint**: `POST /api/musician/composition`

### 3. Audio Feedback
Upload audio for detailed mix, master, or composition analysis.

**Fields:**
- Audio File (required): upload audio file
- Analysis Type: mixdown, mastering, composition, arrangement, performance, transcription, all
- Genre (optional): for context-aware analysis
- Reference Notes (optional): specific concerns or reference tracks

**API Endpoints:**
- `POST /api/musician/upload` - Upload audio file
- `POST /api/musician/analyze` - Run analysis

**Features:**
- Displays technical metrics (duration, sample rate, loudness, etc.)
- Shows confidence level in analysis
- Provides structured feedback reports
- Lists warnings about unavailable backends

### 4. Text-to-Music Sample Generation
Generate music samples from text descriptions.

**Fields:**
- Prompt (required): Describe genre, mood, instruments
- Duration (required): 5-60 seconds (max)
- Tempo (optional): BPM value
- Key (optional): e.g., "C major"
- Genre (optional): e.g., "electronic"
- Dry Run checkbox: Preview without generating audio

**API Endpoint**: `POST /api/musician/generate`

**Safety Features:**
- Validates prompts for unsafe soundalike requests
- Rejects direct artist impersonation attempts
- Caps duration at 60 seconds maximum
- Provides warnings and suggested alternatives

### 5. Practice Plan Generator
Create personalized practice routines with clear goals.

**Fields:**
- Instrument (required): e.g., "guitar", "piano", "drums"
- Practice Goal (required): e.g., "improve fingerpicking technique"
- Minutes per Day (required): 10-480 minutes
- Days per Week (required): 1-7 days
- Current Skill Level: beginner, intermediate, advanced, professional

**API Endpoint**: `POST /api/musician/practice-plan`

## UI Features

### Loading States
- Buttons show "Generating..." or "Analyzing..." text during API calls
- Buttons are disabled while processing

### Error Handling
- Error banner appears at top of page
- Auto-dismisses after 5 seconds
- Clear error messages from API failures

### Results Display
- Markdown formatting for text responses
- Structured display for technical metrics
- Warnings section for backend availability issues
- Confidence scores for analysis results
- Color-coded sections for different result types

### Responsive Design
- Mobile-friendly layout
- Tab navigation for easy switching between features
- Form validation for required fields
- File upload with visual feedback

## Technical Details

### Files
- `/web/musician.html` - Main HTML structure
- `/web/js/musician.js` - JavaScript for API calls and UI interactions
- `/web/css/musician.css` - Styling and responsive layout

### Dependencies
- No external JavaScript libraries required
- Uses native Fetch API for HTTP requests
- Pure CSS (no frameworks)

### Browser Support
- Modern browsers with ES6 support
- Fetch API support required
- File API support for audio uploads

## Development

### Adding New Features
1. Add new tab button in `musician.html`
2. Create new tab pane section
3. Add form handler in `musician.js`
4. Implement API endpoint in backend
5. Style as needed in `musician.css`

### Testing
- Test all forms with valid and invalid data
- Verify error handling with backend unavailable
- Check responsive layout on mobile devices
- Test file upload with various audio formats
- Verify dry-run mode for generation

## Troubleshooting

### Common Issues

**"Failed to generate"**
- Check that backend services are running
- Verify API endpoint is accessible
- Check console for detailed error messages

**"Backend not available"**
- Some features require optional backends (Essentia, Basic Pitch)
- See warnings in results for which backends are missing
- Install required dependencies or use dry-run mode

**File upload fails**
- Check file size limits (see MUSICIAN_MAX_UPLOAD_MB env var)
- Verify file is valid audio format
- Check network connectivity

## API Integration

All endpoints expect JSON payloads and return JSON responses.

### Success Response Format
```json
{
  "data": { /* feature-specific data */ },
  "warnings": ["optional warning messages"],
  "confidence": 0.95  // for analysis endpoints
}
```

### Error Response Format
```json
{
  "error": "Error message here",
  "details": "Optional detailed information"
}
```

## Environment Configuration

Backend features can be enabled/disabled via environment variables:

- `MUSICIAN_ENABLE_MUSICGEN`: Enable local MusicGen for generation
- `MUSICIAN_ENABLE_ESSENTIA`: Enable Essentia for advanced analysis
- `MUSICIAN_ENABLE_BASIC_PITCH`: Enable Basic Pitch for transcription
- `MUSICIAN_GENERATION_PROVIDER`: Set to `mock`, `local_musicgen`, or `huggingface`

## Future Enhancements

Potential improvements:
- Real-time audio preview
- Interactive music notation display
- Save and load sessions
- Export results to various formats
- Collaborative features
- Audio waveform visualization
- MIDI file generation
- Integration with DAW software
