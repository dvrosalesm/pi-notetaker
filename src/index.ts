/**
 * pi-notetaker — Granola-like meeting capture for pi
 *
 * Record, transcribe, and summarize meetings using local models.
 *
 * Commands:
 *   /meeting start [name]    — Start recording
 *   /meeting stop            — Stop recording, transcribe & summarize
 *   /meeting list            — List past meetings
 *   /meeting view <id>       — View a meeting's summary
 *   /meeting transcript <id> — View raw transcript
 *   /meeting delete <id>     — Delete a meeting
 *   /meeting setup           — Check dependencies
 *   /meeting status          — Check recording status
 *   /meeting config          — Show/set configuration
 *   /meeting help            — Show help
 *
 * Tools (LLM-callable):
 *   meeting_setup, meeting_start, meeting_stop, meeting_status, meeting_list, meeting_view, meeting_delete
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import * as recorder from "./recorder.js";
import { transcribe } from "./transcriber.js";
import { summarize } from "./summarizer.js";

const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

// Use ~/.pi/meetings by default (works in any pi agent).
// Falls back to ~/.cmd0/meetings if running inside cmd0.
const DATA_ROOT = fs.existsSync(path.join(os.homedir(), ".cmd0"))
  ? path.join(os.homedir(), ".cmd0")
  : path.join(os.homedir(), ".pi");

const MEETINGS_DIR = path.join(DATA_ROOT, "meetings");
const MODELS_DIR = path.join(DATA_ROOT, "models");
const CONFIG_PATH = path.join(DATA_ROOT, "meetings-config.json");

const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

// ── Config ──────────────────────────────────────────────────────────

interface MeetingConfig {
  device?: string;
  whisperBackend?: "cli" | "api";
  whisperBin?: string;
  whisperModel?: string;
  whisperApiUrl?: string;
  recordingBackend?: "sox" | "ffmpeg";
  language?: string;
  sampleRate?: number;
}

const CONFIG_KEYS: Record<string, "string" | "number"> = {
  device: "string",
  whisperBackend: "string",
  whisperBin: "string",
  whisperModel: "string",
  whisperApiUrl: "string",
  recordingBackend: "string",
  language: "string",
  sampleRate: "number",
};

function loadConfig(): MeetingConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function saveConfig(config: MeetingConfig) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function setConfigValue(config: MeetingConfig, key: string, value: string): string | null {
  if (!(key in CONFIG_KEYS)) {
    return `Unknown config key: ${key}. Valid keys: ${Object.keys(CONFIG_KEYS).join(", ")}`;
  }
  if (value === "null" || value === "unset") {
    delete (config as Record<string, unknown>)[key];
  } else if (CONFIG_KEYS[key] === "number") {
    const num = Number(value);
    if (isNaN(num)) return `${key} must be a number`;
    (config as Record<string, unknown>)[key] = num;
  } else {
    (config as Record<string, unknown>)[key] = value;
  }
  saveConfig(config);
  return null;
}

// ── Meeting metadata ────────────────────────────────────────────────

interface MeetingMetadata {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  duration?: number;
  hasTranscript: boolean;
  hasSummary: boolean;
}

function generateMeetingId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${ts}_${suffix}`;
}

function listMeetings(): MeetingMetadata[] {
  if (!fs.existsSync(MEETINGS_DIR)) return [];

  return fs.readdirSync(MEETINGS_DIR)
    .filter((d) => {
      try { return fs.statSync(path.join(MEETINGS_DIR, d)).isDirectory(); } catch { return false; }
    })
    .map((id) => {
      const metaPath = path.join(MEETINGS_DIR, id, "metadata.json");
      if (fs.existsSync(metaPath)) {
        try {
          return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as MeetingMetadata;
        } catch {}
      }
      return { id, name: id, startedAt: 0, hasTranscript: false, hasSummary: false };
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}

function findMeeting(idOrIndex: string): MeetingMetadata | null {
  const meetings = listMeetings();
  const idx = parseInt(idOrIndex, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= meetings.length) {
    return meetings[idx - 1];
  }
  return meetings.find((m) => m.id.startsWith(idOrIndex)) || null;
}

// ── Dependency detection & installation ─────────────────────────────

interface DepStatus {
  name: string;
  found: boolean;
  detail: string;
}

function which(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const WHISPER_BINARIES = ["whisper-cli", "whisper-cpp", "whisper"] as const;

function checkDeps(config: MeetingConfig): DepStatus[] {
  const deps: DepStatus[] = [];

  const hasSox = which("rec");
  const hasFfmpeg = which("ffmpeg");
  deps.push({
    name: "recorder",
    found: hasSox || hasFfmpeg,
    detail: hasSox ? "sox (rec)" : hasFfmpeg ? "ffmpeg" : "missing — need sox or ffmpeg",
  });

  const customBin = config.whisperBin || process.env.WHISPER_BIN;
  const hasCustomBin = !!(customBin && which(customBin));
  const hasWhisperCli = hasCustomBin || WHISPER_BINARIES.some(which);
  const hasWhisperApi = !!(config.whisperApiUrl || process.env.WHISPER_API_URL);
  deps.push({
    name: "transcriber",
    found: hasWhisperCli || hasWhisperApi,
    detail: hasCustomBin
      ? customBin!
      : hasWhisperCli
        ? WHISPER_BINARIES.find(which)!
        : hasWhisperApi
          ? `API at ${config.whisperApiUrl || process.env.WHISPER_API_URL}`
          : "missing — need whisper-cpp or a local whisper API",
  });

  const modelPath = config.whisperModel || process.env.WHISPER_MODEL;
  let hasModel = false;
  if (modelPath && fs.existsSync(modelPath)) {
    hasModel = true;
  } else if (fs.existsSync(MODELS_DIR)) {
    const files = fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith(".bin") || f.endsWith(".ggml"));
    hasModel = files.length > 0;
  }
  if (hasWhisperApi && !hasWhisperCli) {
    deps.push({ name: "whisper-model", found: true, detail: "not needed (using API)" });
  } else {
    deps.push({
      name: "whisper-model",
      found: hasModel,
      detail: hasModel ? "found" : `missing — no .bin in ${MODELS_DIR}`,
    });
  }

  return deps;
}

// ── Shared meeting operations ───────────────────────────────────────
// Used by both commands and tools to avoid duplicated logic.

interface ActiveMeeting {
  id: string;
  name: string;
  dir: string;
  startedAt: number;
}

let activeMeeting: ActiveMeeting | null = null;
let stopInProgress = false;

function startMeeting(
  name: string,
  config: MeetingConfig,
): { ok: true; meeting: ActiveMeeting } | { ok: false; error: string } {
  if (activeMeeting) {
    return { ok: false, error: "Already recording. Stop the current meeting first." };
  }
  if (stopInProgress) {
    return { ok: false, error: "Previous meeting is still being processed. Please wait." };
  }

  const id = generateMeetingId();
  const dir = path.join(MEETINGS_DIR, id);

  const result = recorder.start({
    outputDir: dir,
    device: config.device,
    sampleRate: config.sampleRate,
    backend: config.recordingBackend,
  });

  if (!result.ok) return result;

  const startedAt = Date.now();
  activeMeeting = { id, name, dir, startedAt };

  const meta: MeetingMetadata = {
    id,
    name,
    startedAt,
    hasTranscript: false,
    hasSummary: false,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2));

  return { ok: true, meeting: activeMeeting };
}

async function stopMeeting(
  config: MeetingConfig,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<
  | { ok: true; meeting: ActiveMeeting; transcript: string; summary?: string; durationSec: number }
  | { ok: false; error: string }
> {
  if (!activeMeeting) {
    return { ok: false, error: "Not currently recording." };
  }
  if (stopInProgress) {
    return { ok: false, error: "Stop already in progress." };
  }

  // Capture meeting info before clearing state
  const meeting = { ...activeMeeting };
  stopInProgress = true;

  try {
    ctx.ui.setStatus("pi-notetaker", "Stopping...");
    const stopResult = await recorder.stop();
    if (!stopResult.ok) {
      return { ok: false, error: stopResult.error };
    }

    const durationSec = Math.round(stopResult.duration / 1000);

    // Transcribe
    ctx.ui.setStatus("pi-notetaker", "Transcribing...");
    const { transcript } = await transcribe({
      audioPath: stopResult.outputPath,
      outputDir: meeting.dir,
      backend: config.whisperBackend,
      binaryPath: config.whisperBin || process.env.WHISPER_BIN,
      modelPath: config.whisperModel || process.env.WHISPER_MODEL,
      apiUrl: config.whisperApiUrl || process.env.WHISPER_API_URL,
      language: config.language,
      signal,
    });

    // Summarize
    ctx.ui.setStatus("pi-notetaker", "Summarizing...");
    const summaryResult = await summarize(transcript, ctx, signal);
    let summary: string | undefined;
    if ("summary" in summaryResult) {
      summary = summaryResult.summary;
      fs.writeFileSync(path.join(meeting.dir, "summary.md"), summary, "utf-8");
    }

    // Update metadata with the original startedAt
    const meta: MeetingMetadata = {
      id: meeting.id,
      name: meeting.name,
      startedAt: meeting.startedAt,
      endedAt: Date.now(),
      duration: stopResult.duration,
      hasTranscript: true,
      hasSummary: !!summary,
    };
    fs.writeFileSync(path.join(meeting.dir, "metadata.json"), JSON.stringify(meta, null, 2));

    return { ok: true, meeting, transcript, summary, durationSec };
  } finally {
    activeMeeting = null;
    stopInProgress = false;
    ctx.ui.setStatus("pi-notetaker", "");
  }
}

function truncateForNotify(text: string, maxLines = 30): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n\n... (truncated, ${lines.length - maxLines} more lines)`;
}

// ── Extension entry point ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  // ── Platform check ────────────────────────────────────────────────

  if (!IS_MAC && !IS_LINUX) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "pi-notetaker: unsupported platform. Only macOS and Linux are supported.",
        "warning",
      );
    });
    return;
  }

  // ── /meeting command ──────────────────────────────────────────────

  pi.registerCommand("meeting", {
    description: "Meeting recorder: start, stop, list, view, transcript, setup, status, config",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "help";
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "start": {
          const name = rest || `Meeting ${new Date().toLocaleString()}`;
          const result = startMeeting(name, config);
          if (!result.ok) {
            ctx.ui.notify(result.error, "warning");
            return;
          }
          ctx.ui.notify(`Recording started: ${name}`, "info");
          ctx.ui.setStatus("pi-notetaker", "Recording...");
          return;
        }

        case "stop": {
          const result = await stopMeeting(config, ctx);
          if (!result.ok) {
            ctx.ui.notify(result.error, "warning");
            return;
          }
          ctx.ui.notify(`Meeting saved: ${result.meeting.name} (${result.durationSec}s)`, "info");
          if (result.summary) {
            pi.sendUserMessage(
              `[Meeting ended: "${result.meeting.name}" — ${result.durationSec}s]\n\n${result.summary}`,
            );
          }
          return;
        }

        case "list": {
          const meetings = listMeetings();
          if (meetings.length === 0) {
            ctx.ui.notify("No meetings recorded yet.", "info");
            return;
          }
          const lines = meetings.map((m, i) => {
            const date = new Date(m.startedAt).toLocaleString();
            const dur = m.duration ? `${Math.round(m.duration / 1000)}s` : "?";
            const flags = [m.hasTranscript ? "T" : "", m.hasSummary ? "S" : ""].filter(Boolean).join("");
            return `${i + 1}. ${m.name} (${date}, ${dur}) [${flags}]`;
          });
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        case "view": {
          if (!rest) { ctx.ui.notify("Usage: /meeting view <id or number>", "warning"); return; }
          const meeting = findMeeting(rest);
          if (!meeting) { ctx.ui.notify(`Meeting not found: ${rest}`, "error"); return; }
          const summaryPath = path.join(MEETINGS_DIR, meeting.id, "summary.md");
          if (!fs.existsSync(summaryPath)) { ctx.ui.notify("No summary for this meeting.", "warning"); return; }
          const summary = fs.readFileSync(summaryPath, "utf-8");
          ctx.ui.notify(truncateForNotify(`--- ${meeting.name} ---\n\n${summary}`), "info");
          return;
        }

        case "transcript": {
          if (!rest) { ctx.ui.notify("Usage: /meeting transcript <id or number>", "warning"); return; }
          const meeting = findMeeting(rest);
          if (!meeting) { ctx.ui.notify(`Meeting not found: ${rest}`, "error"); return; }
          const transcriptPath = path.join(MEETINGS_DIR, meeting.id, "transcript.txt");
          if (!fs.existsSync(transcriptPath)) { ctx.ui.notify("No transcript for this meeting.", "warning"); return; }
          const transcript = fs.readFileSync(transcriptPath, "utf-8");
          ctx.ui.notify(truncateForNotify(`--- Transcript: ${meeting.name} ---\n\n${transcript}`), "info");
          return;
        }

        case "delete": {
          if (!rest) { ctx.ui.notify("Usage: /meeting delete <id or number>", "warning"); return; }
          const meeting = findMeeting(rest);
          if (!meeting) { ctx.ui.notify(`Meeting not found: ${rest}`, "error"); return; }
          const meetingDir = path.join(MEETINGS_DIR, meeting.id);
          fs.rmSync(meetingDir, { recursive: true, force: true });
          ctx.ui.notify(`Deleted meeting: ${meeting.name}`, "info");
          return;
        }

        case "config": {
          if (!rest) {
            ctx.ui.notify(
              `Meeting config (${CONFIG_PATH}):\n${JSON.stringify(config, null, 2)}\n\nValid keys: ${Object.keys(CONFIG_KEYS).join(", ")}`,
              "info",
            );
            return;
          }
          const [key, ...valParts] = rest.split(/\s+/);
          const value = valParts.join(" ");
          if (!key || !value) { ctx.ui.notify("Usage: /meeting config <key> <value>", "warning"); return; }
          const err = setConfigValue(config, key, value);
          if (err) { ctx.ui.notify(err, "error"); return; }
          ctx.ui.notify(`Set ${key} = ${value}`, "info");
          return;
        }

        case "setup": {
          const deps = checkDeps(config);
          const missing = deps.filter((d) => !d.found);

          const statusText = deps.map((d) => `  ${d.found ? "+" : "x"} ${d.name}: ${d.detail}`).join("\n");

          if (missing.length === 0) {
            ctx.ui.notify(`All dependencies installed:\n${statusText}`, "info");
          } else {
            ctx.ui.notify(
              `Dependency check:\n${statusText}\n\n` +
              "Install missing dependencies with your package manager:\n" +
              "  macOS:  brew install sox ffmpeg whisper-cpp\n" +
              "  Ubuntu: sudo apt install sox ffmpeg\n" +
              "  Arch:   sudo pacman -S sox ffmpeg\n\n" +
              `Whisper model: download a ggml model to ${MODELS_DIR}/`,
              missing.length > 0 ? "warning" : "info",
            );
          }
          return;
        }

        case "status": {
          const recState = recorder.getState();
          if (!recState.recording || !activeMeeting) {
            ctx.ui.notify("Not recording.", "info");
          } else {
            const elapsed = Math.round((Date.now() - activeMeeting.startedAt) / 1000);
            ctx.ui.notify(`Recording: "${activeMeeting.name}" (${elapsed}s elapsed)`, "info");
          }
          return;
        }

        case "help":
        default:
          ctx.ui.notify(
            "Usage: /meeting <subcommand>\n\n" +
            "  start [name]       — Start recording a meeting\n" +
            "  stop               — Stop, transcribe & summarize\n" +
            "  list               — List past meetings\n" +
            "  view <id>          — View meeting summary\n" +
            "  transcript <id>    — View raw transcript\n" +
            "  delete <id>        — Delete a meeting\n" +
            "  setup              — Check dependencies\n" +
            "  status             — Check recording status\n" +
            "  config [key val]   — Show/set configuration\n" +
            "  help               — Show this help",
            "info",
          );
      }
    },
  });

  // ── LLM-callable tools ────────────────────────────────────────────

  const StartParams = Type.Object({
    name: Type.Optional(Type.String({ description: "Meeting name/title" })),
  });

  pi.registerTool({
    name: "meeting_start",
    label: "Start Meeting Recording",
    description:
      "Start recording a meeting. Records audio from the microphone (or configured virtual audio device) for later transcription and summarization.",
    parameters: StartParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { name } = params as Static<typeof StartParams>;
      const meetingName = name || `Meeting ${new Date().toLocaleString()}`;

      const result = startMeeting(meetingName, config);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error }],
          details: { status: "error" },
        };
      }

      ctx.ui.setStatus("pi-notetaker", "Recording...");
      return {
        content: [{ type: "text", text: `Recording started: "${meetingName}" (ID: ${result.meeting.id})` }],
        details: { status: "recording", meetingId: result.meeting.id, name: meetingName },
      };
    },
  });

  pi.registerTool({
    name: "meeting_stop",
    label: "Stop Meeting Recording",
    description:
      "Stop the current meeting recording, transcribe the audio using local Whisper, and generate a structured summary using the active LLM.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const result = await stopMeeting(config, ctx, signal);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error }],
          details: { status: "error" },
        };
      }

      const output = result.summary
        ? `Meeting "${result.meeting.name}" (${result.durationSec}s) recorded and summarized.\n\n${result.summary}`
        : `Meeting "${result.meeting.name}" (${result.durationSec}s) recorded and transcribed.\n\nTranscript:\n${result.transcript}`;

      return {
        content: [{ type: "text", text: output }],
        details: {
          status: "complete",
          meetingId: result.meeting.id,
          duration: result.durationSec,
          hasSummary: !!result.summary,
        },
      };
    },
  });

  pi.registerTool({
    name: "meeting_status",
    label: "Meeting Status",
    description: "Check if a meeting is currently being recorded and its duration so far.",
    parameters: Type.Object({}),
    async execute() {
      if (!activeMeeting || !recorder.getState().recording) {
        return {
          content: [{ type: "text", text: "No meeting is currently being recorded." }],
          details: { recording: false },
        };
      }

      const elapsed = Math.round((Date.now() - activeMeeting.startedAt) / 1000);
      return {
        content: [{ type: "text", text: `Recording in progress: "${activeMeeting.name}" (${elapsed}s elapsed)` }],
        details: { recording: true, meetingId: activeMeeting.id, name: activeMeeting.name, elapsed },
      };
    },
  });

  pi.registerTool({
    name: "meeting_list",
    label: "List Meetings",
    description: "List all past recorded meetings with their timestamps, durations, and available data.",
    parameters: Type.Object({}),
    async execute() {
      const meetings = listMeetings();
      if (meetings.length === 0) {
        return {
          content: [{ type: "text", text: "No meetings recorded yet." }],
          details: { count: 0 },
        };
      }

      const lines = meetings.map((m, i) => {
        const date = new Date(m.startedAt).toLocaleString();
        const dur = m.duration ? `${Math.round(m.duration / 1000)}s` : "unknown";
        const parts = [m.hasTranscript ? "transcript" : "", m.hasSummary ? "summary" : ""]
          .filter(Boolean)
          .join(", ");
        return `${i + 1}. **${m.name}** — ${date} (${dur}) [${parts}]`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: meetings.length, meetings },
      };
    },
  });

  const ViewParams = Type.Object({
    meeting: Type.String({ description: "Meeting ID, ID prefix, or list index number" }),
    content: Type.Optional(
      Type.Union([Type.Literal("summary"), Type.Literal("transcript")], {
        description: "What to view: summary (default) or transcript",
      }),
    ),
  });

  pi.registerTool({
    name: "meeting_view",
    label: "View Meeting",
    description: "View a past meeting's summary or transcript by ID or index number.",
    parameters: ViewParams,
    async execute(_toolCallId, params) {
      const { meeting: meetingRef, content: viewType } = params as Static<typeof ViewParams>;

      const meeting = findMeeting(meetingRef);
      if (!meeting) {
        return {
          content: [{ type: "text", text: `Meeting not found: ${meetingRef}` }],
          details: { status: "not_found" },
        };
      }

      const type = viewType || "summary";
      const filePath =
        type === "transcript"
          ? path.join(MEETINGS_DIR, meeting.id, "transcript.txt")
          : path.join(MEETINGS_DIR, meeting.id, "summary.md");

      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `No ${type} available for "${meeting.name}"` }],
          details: { status: "missing", type },
        };
      }

      const fileContent = fs.readFileSync(filePath, "utf-8");
      return {
        content: [{ type: "text", text: `**${meeting.name}** (${type}):\n\n${fileContent}` }],
        details: { meetingId: meeting.id, type },
      };
    },
  });

  const DeleteParams = Type.Object({
    meeting: Type.String({ description: "Meeting ID, ID prefix, or list index number" }),
  });

  pi.registerTool({
    name: "meeting_delete",
    label: "Delete Meeting",
    description: "Delete a past meeting and all its data (audio, transcript, summary) by ID or index number.",
    parameters: DeleteParams,
    async execute(_toolCallId, params) {
      const { meeting: meetingRef } = params as Static<typeof DeleteParams>;

      const meeting = findMeeting(meetingRef);
      if (!meeting) {
        return {
          content: [{ type: "text", text: `Meeting not found: ${meetingRef}` }],
          details: { status: "not_found" },
        };
      }

      const meetingDir = path.join(MEETINGS_DIR, meeting.id);
      fs.rmSync(meetingDir, { recursive: true, force: true });

      return {
        content: [{ type: "text", text: `Deleted meeting: "${meeting.name}" (${meeting.id})` }],
        details: { status: "deleted", meetingId: meeting.id },
      };
    },
  });

  pi.registerTool({
    name: "meeting_setup",
    label: "Check Meeting Dependencies",
    description:
      "Check all dependencies needed for meeting recording (sox/ffmpeg, whisper-cpp, whisper model). " +
      "Reports what is installed and what is missing. The agent should install missing dependencies " +
      "using the appropriate system package manager (brew on macOS, apt/pacman/etc on Linux).",
    parameters: Type.Object({}),
    async execute() {
      const deps = checkDeps(config);
      const missing = deps.filter((d) => !d.found);

      const statusLines = deps.map(
        (d) => `${d.found ? "[OK]" : "[MISSING]"} ${d.name}: ${d.detail}`,
      );

      if (missing.length === 0) {
        return {
          content: [{ type: "text", text: `All dependencies installed:\n${statusLines.join("\n")}` }],
          details: { status: "ready", deps },
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Missing dependencies:\n${statusLines.join("\n")}\n\n` +
              "Install with the appropriate package manager:\n" +
              "  macOS:  brew install sox ffmpeg whisper-cpp\n" +
              "  Ubuntu: sudo apt install sox ffmpeg\n" +
              "  Arch:   sudo pacman -S sox ffmpeg\n\n" +
              `Whisper model: download a ggml model to ${MODELS_DIR}/\n` +
              `  curl -L -o ${MODELS_DIR}/ggml-base.en.bin ${WHISPER_MODEL_URL}`,
          },
        ],
        details: { status: "missing", missing: missing.map((d) => d.name) },
      };
    },
  });

  // ── Session lifecycle ─────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    fs.mkdirSync(MEETINGS_DIR, { recursive: true });

    const deps = checkDeps(config);
    const missing = deps.filter((d) => !d.found);

    if (missing.length > 0) {
      const names = missing.map((d) => d.name).join(", ");
      ctx.ui.notify(
        `pi-notetaker: missing dependencies (${names}). Run /meeting setup to install.`,
        "warning",
      );
    } else {
      const count = listMeetings().length;
      ctx.ui.notify(
        `pi-notetaker loaded. ${count} meeting(s) on file. Use /meeting start to begin recording.`,
        "info",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    if (recorder.getState().recording) {
      await recorder.stop();
    }
  });
}
