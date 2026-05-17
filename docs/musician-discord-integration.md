# Musician Assistant - Discord Bot Integration

## Overview

The Musician Assistant features are fully integrated into the Discord bot, allowing users to access music theory tutoring, composition assistance, music generation, and practice planning directly from Discord chat.

## Available Commands

### 1. `/music-theory` - Music Theory Tutor

Learn music theory concepts with interactive explanations.

**Usage:**
```
/music-theory topic:chord progressions level:intermediate instrument:piano
```

**Parameters:**
- `topic` (required): Music theory topic to learn
  - Examples: "dominant seventh chords", "circle of fifths", "voice leading", "modal interchange"
- `level` (optional): Your skill level
  - Options: `beginner`, `intermediate`, `advanced`, `pro`
  - Default: `intermediate`
- `instrument` (optional): Your instrument for context-specific examples
  - Examples: "piano", "guitar", "bass", "drums"

**Example:**
```
/music-theory topic:jazz chord voicings level:advanced instrument:piano
```

**Response:**
The bot will provide a detailed explanation tailored to your skill level, with examples specific to your instrument if provided.

---

### 2. `/compose` - Composition Assistant

Get help with songwriting, chord progressions, and arrangement.

**Usage:**
```
/compose goal:write a bridge genre:pop mood:uplifting key:C major
```

**Parameters:**
- `goal` (required): What you want to compose
  - Examples: "write a chorus", "create a bridge", "develop a verse melody", "write a complete song"
- `genre` (optional): Musical genre
  - Examples: "pop", "rock", "jazz", "electronic", "classical", "hip-hop"
- `mood` (optional): Emotional tone
  - Examples: "uplifting", "melancholic", "tense", "relaxed", "energetic"
- `key` (optional): Musical key
  - Examples: "C major", "Am", "D dorian", "F# minor"

**Example:**
```
/compose goal:write a jazz piano solo genre:jazz mood:contemplative key:Bb major
```

**Response:**
The bot will provide composition guidance, chord progressions, melodic ideas, and arrangement suggestions.

---

### 3. `/generate-music` - Text-to-Music Generation

Generate music samples from text descriptions.

**Usage:**
```
/generate-music prompt:upbeat electronic dance music duration:15 dryrun:true
```

**Parameters:**
- `prompt` (required): Description of the music you want
  - Be descriptive about genre, mood, instruments, and style
  - **Avoid requesting soundalikes of specific artists** (see Safety Notes below)
  - Examples:
    - "upbeat electronic dance music with synth leads and driving bassline"
    - "mellow acoustic guitar with soft percussion"
    - "intense orchestral piece with dramatic strings"
- `duration` (optional): Length in seconds
  - Range: 5-60 seconds
  - Default: 15 seconds
- `dryrun` (optional): Preview only without generating audio
  - Default: `false`
  - Set to `true` to test prompts without actual generation

**Examples:**
```
/generate-music prompt:ambient electronic soundscape with pads duration:30

/generate-music prompt:funky bass and drums groove duration:15 dryrun:true
```

**Safety Notes:**
- ❌ **Do not request**: "sounds like Taylor Swift", "in the style of Drake"
- ✅ **Instead request**: "pop vocals with modern production", "hip-hop beat with trap influences"
- The system will reject or rewrite prompts that request direct artist soundalikes

**Response:**
- In dry-run mode: Validation and preview of what would be generated
- In generation mode: Asset ID, model used, duration, and any warnings
- Warnings will be shown if the backend is unavailable (mock mode)

---

### 4. `/practice-plan` - Practice Plan Generator

Create personalized practice routines.

**Usage:**
```
/practice-plan instrument:guitar goal:improve fingerpicking minutes:45 days:5
```

**Parameters:**
- `instrument` (required): Instrument to practice
  - Examples: "guitar", "piano", "drums", "bass", "voice", "violin"
- `goal` (required): Practice objective
  - Examples:
    - "improve fingerpicking technique"
    - "learn jazz voicings"
    - "build endurance for live performance"
    - "master sight-reading"
- `minutes` (optional): Minutes per day
  - Range: 10-480 minutes
  - Default: 30 minutes
- `days` (optional): Days per week
  - Range: 1-7 days
  - Default: 5 days

**Example:**
```
/practice-plan instrument:piano goal:prepare for jazz standards performance minutes:60 days:6
```

**Response:**
A structured practice plan with warm-ups, focused exercises, and cool-down activities tailored to your goal and time commitment.

---

### 5. `/chat` - General Chat (with Musician Mode)

Chat with the AI in musician mode for general music-related conversations.

**Usage:**
```
/chat message:How do I improve my jazz improvisation? mode:musician
```

**Parameters:**
- `message` (required): Your question or message
- `mode` (optional): Agent mode
  - Options: `productivity`, `engineering`, `musician`
  - Use `musician` for music-related conversations

**Example:**
```
/chat message:What's the best way to practice scales for improvisation? mode:musician
```

---

## Direct Mentions

You can also mention the bot directly in any channel:

```
@AIAssistant Can you explain the circle of fifths?
```

The bot will respond in the channel. For music-specific conversations, it will automatically use context to provide music-related answers.

---

## Session Management

Create persistent conversation sessions for continued discussions:

```
/session action:start
```

This allows the bot to maintain context across multiple messages. Useful for:
- Extended music theory lessons
- Iterative composition development
- Progressive practice plan refinement

End sessions when done:
```
/session action:end
```

---

## Response Format

### Theory Explanations
```
🎵 **Music Theory: Circle of Fifths**

The circle of fifths is a visual representation of the relationships
among the 12 tones of the chromatic scale...

[Detailed explanation with examples]
```

### Composition Plans
```
🎼 **Composition Plan**

## Goal: Write a Bridge
## Genre: Pop
## Key: C Major

**Chord Progression:**
| C | Am | F | G |

**Melodic Approach:**
- Start on the 5th (G) for contrast with verse...

[Detailed composition guidance]
```

### Generation Results
```
🎹 **Music Generation**

**Prompt**: upbeat electronic dance music
**Duration**: 15s
**Model**: facebook/musicgen-small

✅ Generation complete!
**Asset ID**: gen_1234567890

⚠️ **Warnings**:
• Mock mode: No actual audio generated
• To generate real audio, configure backend
```

### Practice Plans
```
📝 **Practice Plan for Guitar**

## 30-Minute Daily Practice (5 days/week)

**Warm-up (5 min):**
- Chromatic scale exercises
- Finger stretches

**Focused Practice (20 min):**
- Fingerpicking patterns...

[Detailed practice routine]
```

---

## Error Handling

### Command Errors
If a command fails, the bot will provide a clear error message:

```
❌ Failed to generate music. Please try again.
```

### Validation Errors
Invalid prompts will be caught with helpful feedback:

```
❌ Unsafe generation request: Prompt requests a direct soundalike of protected artist: Taylor Swift

Suggested alternative: "Contemporary pop music with modern production"
```

### Backend Unavailable
When advanced features are unavailable, warnings are shown:

```
⚠️ **Warnings**:
• Essentia not available - using basic analysis only
• Basic Pitch transcription disabled
• Using mock generation mode
```

---

## Best Practices

### 1. Be Specific in Prompts
❌ "Generate music"
✅ "Generate upbeat electronic dance music with synth leads and driving bassline at 128 BPM"

### 2. Use Dry Run for Testing
Before generating actual audio, test your prompt:
```
/generate-music prompt:your description dryrun:true
```

### 3. Break Down Complex Requests
For complex compositions, use multiple interactions:
1. Start with overall structure
2. Ask for specific sections
3. Refine based on feedback

### 4. Leverage Context with Sessions
Start a session for multi-message conversations:
```
/session action:start
```

### 5. Use Appropriate Modes
- Quick questions: Direct mention
- Structured requests: Slash commands
- Extended discussions: Sessions with `/chat mode:musician`

---

## Limits and Constraints

### Rate Limits
- Commands are subject to Discord's rate limits
- Responses over 2000 characters are automatically split

### Generation Limits
- Maximum duration: 60 seconds
- Generation may be queued if backend is busy
- Dry run has no limits

### File Uploads
Currently, audio file uploads for analysis are not supported via Discord. Use the web UI at `/musician` for audio analysis.

---

## Examples by Use Case

### Learning Music Theory
```
/music-theory topic:secondary dominants level:intermediate instrument:piano
```

### Writing a Song
```
/session action:start
/compose goal:write a complete song structure genre:indie rock mood:nostalgic
[Review response]
/compose goal:develop verse melody key:G major
[Continue iterating]
/session action:end
```

### Creating Practice Routine
```
/practice-plan instrument:guitar goal:master barre chords minutes:30 days:6
```

### Generating Background Music
```
/generate-music prompt:calm ambient background music with soft pads duration:30 dryrun:true
[Review prompt validation]
/generate-music prompt:calm ambient background music with soft pads duration:30
```

### Music Discussion
```
@AIAssistant What's the difference between Lydian and Ionian modes?
```

---

## Troubleshooting

### "Command not found"
- Commands may take up to 1 hour to propagate globally
- Try restarting Discord client
- Check bot permissions in server settings

### "This bot is not available to you"
- Bot may be restricted to specific users
- Contact server administrator

### "Failed to connect to agent"
- Backend service may be down
- Check with administrator
- Try again in a few minutes

### Long Response Times
- Music generation can take 10-30 seconds
- Complex analysis may take longer
- Use `/session action:info` to check if session is active

---

## Privacy and Data

### What Data is Stored
- Discord user ID (for session management)
- Conversation history (if sessions are used)
- Generated asset metadata

### What Data is NOT Stored
- Discord messages outside of explicit commands
- Audio files (temporary, cleaned up after 1 hour)
- Personal information

### Data Retention
- Sessions expire after 24 hours of inactivity
- Generated assets are cleaned up after 24 hours
- Conversation memory is opt-in via `/session` commands

---

## Getting Help

### In Discord
```
/help
```

Shows all available commands and basic usage.

### For Detailed Help
Visit the web UI documentation:
- `/musician` - Web interface
- `/capabilities` - Full feature list

### Support
- Report issues in the designated support channel
- Use `/memory query:your search` to find previous conversations
- Contact administrator for access issues

---

## Advanced Usage

### Combining Commands
Use sessions to build complex workflows:

```
/session action:start
/music-theory topic:modal interchange level:advanced
[Learn the concept]
/compose goal:write chord progression using modal interchange key:C major
[Get composition ideas]
/generate-music prompt:chord progression with modal interchange in C major duration:20
[Hear an example]
/session action:end
```

### Using Memory
Search past conversations for context:

```
/memory query:jazz voicings piano
```

Retrieves previous discussions about jazz voicings on piano.

---

## Summary

The Musician Assistant Discord integration provides:

✅ **Full access to all musician tools** via slash commands
✅ **Interactive conversations** via direct mentions and chat mode
✅ **Session management** for extended discussions
✅ **Safety features** to prevent unsafe generation requests
✅ **Graceful degradation** when backends are unavailable
✅ **Clear error messages** and helpful warnings

Start exploring with `/help` and `/music-theory` to get started! 🎵
