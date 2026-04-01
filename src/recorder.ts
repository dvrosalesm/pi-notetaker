/**
 * Audio recorder module - captures audio via sox (rec) or ffmpeg.
 *
 * Supports recording from:
 *  - Default microphone input
 *  - Virtual audio device (e.g. BlackHole) for system audio capture
 *
 * Outputs WAV files to the meeting directory.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export interface RecorderOptions {
  /** Output directory for the WAV file */
  outputDir: string;
  /** Audio device name (e.g. "BlackHole 2ch"). If omitted, uses default input. */
  device?: string;
  /** Sample rate in Hz. Default: 16000 (optimal for Whisper) */
  sampleRate?: number;
  /** Recording backend: "sox" or "ffmpeg". Auto-detected if omitted. */
  backend?: "sox" | "ffmpeg";
}

export interface RecorderState {
  recording: boolean;
  startedAt?: number;
  outputPath?: string;
  pid?: number;
}

let recordProcess: ChildProcess | null = null;
let state: RecorderState = { recording: false };

function which(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectBackend(): "sox" | "ffmpeg" | null {
  if (which("rec")) return "sox";
  if (which("ffmpeg")) return "ffmpeg";
  return null;
}

function buildSoxArgs(outputPath: string, opts: RecorderOptions): string[] {
  return [
    "-r", String(opts.sampleRate || 16000),
    "-c", "1",    // mono
    "-b", "16",   // 16-bit
    outputPath,
  ];
}

function buildFfmpegArgs(outputPath: string, opts: RecorderOptions): string[] {
  const device = opts.device || "default";
  const sampleRate = String(opts.sampleRate || 16000);

  if (process.platform === "darwin") {
    return [
      "-f", "avfoundation",
      "-i", `:${device}`,
      "-ar", sampleRate,
      "-ac", "1",
      "-sample_fmt", "s16",
      outputPath,
      "-y",
    ];
  }

  // Linux — try PulseAudio, caller can override via device config
  return [
    "-f", "pulse",
    "-i", device,
    "-ar", sampleRate,
    "-ac", "1",
    "-sample_fmt", "s16",
    outputPath,
    "-y",
  ];
}

export function getState(): RecorderState {
  return { ...state };
}

export function start(opts: RecorderOptions): { ok: true } | { ok: false; error: string } {
  if (state.recording) {
    return { ok: false, error: "Already recording" };
  }

  const backend = opts.backend || detectBackend();
  if (!backend) {
    return {
      ok: false,
      error: "Neither sox (rec) nor ffmpeg found. Install one:\n  brew install sox\n  brew install ffmpeg",
    };
  }

  fs.mkdirSync(opts.outputDir, { recursive: true });
  const outputPath = path.join(opts.outputDir, "audio.wav");

  const env: NodeJS.ProcessEnv = { ...process.env };

  let cmd: string;
  let args: string[];

  if (backend === "sox") {
    cmd = "rec";
    args = buildSoxArgs(outputPath, opts);
    if (opts.device) {
      env.AUDIODEV = opts.device;
    }
  } else {
    cmd = "ffmpeg";
    args = buildFfmpegArgs(outputPath, opts);
  }

  try {
    recordProcess = spawn(cmd, args, {
      env,
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });

    recordProcess.on("error", (err) => {
      state = { recording: false };
      recordProcess = null;
      console.error(`[pi-notetaker] recorder error: ${err.message}`);
    });

    recordProcess.on("exit", () => {
      if (state.recording) {
        state = { ...state, recording: false };
      }
      recordProcess = null;
    });

    state = {
      recording: true,
      startedAt: Date.now(),
      outputPath,
      pid: recordProcess.pid,
    };

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Failed to start ${backend}: ${err.message}` };
  }
}

/**
 * Stop recording and wait for the process to flush and exit.
 * Returns after the file is fully written (or timeout).
 */
export async function stop(): Promise<
  { ok: true; outputPath: string; duration: number } | { ok: false; error: string }
> {
  if (!state.recording || !recordProcess) {
    return { ok: false, error: "Not recording" };
  }

  const outputPath = state.outputPath!;
  const duration = Date.now() - state.startedAt!;
  const proc = recordProcess;

  state = { recording: false };
  recordProcess = null;

  // Wait for the process to exit (flushes WAV headers)
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5000);

    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    proc.kill("SIGINT");
  });

  // Validate the output file exists and is non-empty
  if (!fs.existsSync(outputPath)) {
    return { ok: false, error: `Recording file was not created at ${outputPath}` };
  }
  const stat = fs.statSync(outputPath);
  if (stat.size < 100) {
    return { ok: false, error: `Recording file is empty or too small (${stat.size} bytes)` };
  }

  return { ok: true, outputPath, duration };
}
