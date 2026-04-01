# pi-notetaker

Built for [cmd0](https://github.com/dvrosalesm/cmd0) — a desktop AI agent that lives in your system tray.

A [pi](https://github.com/mario-zechner/pi-coding-agent) extension for meeting notes. Record audio, transcribe it locally with Whisper, and generate structured summaries using the active pi LLM — all offline, all local.

Works with **any pi agent** (standalone pi, [cmd0](https://github.com/dvrosalesm/cmd0), or custom SDK apps).

## Quick Install

```bash
# Install from npm
pi install npm:@dvrosalesm/pi-notetaker

# Then inside a pi session, run:
/meeting setup
```

### Install from source

```bash
# Copy or symlink this directory into pi's extensions
cp -r pi-notetaker ~/.pi/agent/extensions/pi-notetaker

# Then inside a pi session, run:
/meeting setup
```

The `/meeting setup` command (or the `meeting_setup` tool) will:
- Install **sox** via Homebrew (for audio recording)
- Install **whisper-cpp** via Homebrew (for local transcription)
- Download the **whisper base.en model** (~142MB) to `~/.pi/models/`

### Manual Install (if Homebrew is unavailable)

```bash
# Recording — install one of:
brew install sox          # provides the `rec` command
brew install ffmpeg       # alternative recorder

# Transcription — install one of:
brew install whisper-cpp  # provides `whisper-cli`
# OR run a local OpenAI-compatible whisper API server

# Whisper model — download to ~/.pi/models/
mkdir -p ~/.pi/models
curl -L -o ~/.pi/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

## Prerequisites

| Dependency | Purpose | Install |
|---|---|---|
| **sox** or **ffmpeg** | Audio recording | `brew install sox` |
| **whisper-cpp** | Local speech-to-text | `brew install whisper-cpp` |
| **Whisper model** (.bin) | Whisper weights | Auto-downloaded by `/meeting setup` |
| **Homebrew** (optional) | Auto-install above | [brew.sh](https://brew.sh) |

**Platforms:** macOS and Linux. Windows is not supported.

For **system audio capture** (not just mic), install [BlackHole](https://github.com/ExistentialAudio/BlackHole) and configure a Multi-Output Device in Audio MIDI Setup, then set the device:

```
/meeting config device "BlackHole 2ch"
```

## Usage

### Commands

| Command | Description |
|---|---|
| `/meeting start [name]` | Start recording audio |
| `/meeting stop` | Stop recording, transcribe & summarize |
| `/meeting list` | List past meetings |
| `/meeting view <id>` | View meeting summary |
| `/meeting transcript <id>` | View raw transcript |
| `/meeting status` | Check if currently recording |
| `/meeting setup` | Check & install dependencies |
| `/meeting config [key val]` | Show or set configuration |

### LLM-Callable Tools

These tools are registered so the LLM can manage meetings conversationally:

| Tool | Description |
|---|---|
| `meeting_setup` | Check & auto-install all dependencies |
| `meeting_start` | Start recording (accepts optional name) |
| `meeting_stop` | Stop, transcribe, and summarize |
| `meeting_status` | Check recording state |
| `meeting_list` | List past meetings |
| `meeting_view` | View a meeting's summary or transcript |

### Agent Integration

To have an AI agent install this extension and set it up programmatically:

1. Copy this directory into `~/.pi/agent/extensions/pi-notetaker/`
2. Call the `meeting_setup` tool with `{ "install": true }` — it will install all system dependencies and download the whisper model
3. Use `meeting_start` / `meeting_stop` to record and process meetings

## Configuration

Config is stored at `~/.pi/meetings-config.json` (or `~/.cmd0/meetings-config.json` if running inside cmd0). Set values with `/meeting config <key> <value>`.

| Key | Description | Default |
|---|---|---|
| `device` | Audio input device name | System default mic |
| `recordingBackend` | `"sox"` or `"ffmpeg"` | Auto-detect |
| `whisperBackend` | `"cli"` or `"api"` | Auto-detect |
| `whisperBin` | Path to whisper binary | Auto-detect |
| `whisperModel` | Path to .bin model file | Auto-detect in `~/.pi/models/` |
| `whisperApiUrl` | Local whisper API URL | `http://localhost:8080` |
| `language` | Transcription language | `"en"` |
| `sampleRate` | Recording sample rate (Hz) | `16000` |

Environment variables `WHISPER_BIN`, `WHISPER_MODEL`, and `WHISPER_API_URL` are also respected.

## How It Works

```
/meeting start "Weekly Standup"
  |
  v
[sox/ffmpeg records audio -> ~/.pi/meetings/<id>/audio.wav]
  |
/meeting stop
  |
  v
[whisper-cpp transcribes audio -> transcript.txt]
  |
  v
[pi's active LLM summarizes transcript -> summary.md]
  |
  v
Summary injected into conversation context
```

1. **Record** — Spawns `rec` (sox) or `ffmpeg` to capture audio at 16kHz mono WAV
2. **Transcribe** — Runs `whisper-cli` locally against the audio file, or POSTs to a local OpenAI-compatible API
3. **Summarize** — Sends the transcript to pi's currently active LLM (same model you're chatting with) with a structured prompt
4. **Store** — Everything saved to `~/.pi/meetings/<timestamp>/` with metadata

## Data Storage

The extension auto-detects the data root:
- **cmd0 users** → `~/.cmd0/` (if it exists)
- **All other pi agents** → `~/.pi/`

```
~/.pi/                         # or ~/.cmd0/
  meetings/
    2026-03-30_14-30-00_a1b2c3/
      audio.wav                # Raw recording
      transcript.txt           # Whisper output
      summary.md               # LLM-generated summary
      metadata.json            # Name, timestamps, flags
  meetings-config.json         # Extension settings
  models/
    ggml-base.en.bin           # Whisper model weights
```

## Extension Structure

```
pi-notetaker/
  package.json           # pi extension manifest
  README.md              # This file
  src/
    index.ts             # Extension entry — commands, tools, events
    recorder.ts          # Audio capture (sox / ffmpeg)
    transcriber.ts       # Local Whisper (CLI / API)
    summarizer.ts        # LLM summarization via pi's active model
```
