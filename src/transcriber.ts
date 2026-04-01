/**
 * Local transcription module.
 *
 * Supports two backends:
 *  1. whisper.cpp CLI  – runs `whisper-cli` or a custom binary path
 *  2. Local OpenAI-compatible API – e.g. faster-whisper-server, whisper.cpp server
 *
 * Configure via environment variables or extension settings.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface TranscribeOptions {
  /** Path to the audio file */
  audioPath: string;
  /** Output directory for the transcript */
  outputDir: string;
  /** Backend: "cli" (whisper.cpp) or "api" (OpenAI-compatible local server). Auto-detected if omitted. */
  backend?: "cli" | "api";
  /** For CLI: path to whisper binary. Default: "whisper-cli" */
  binaryPath?: string;
  /** For CLI: path to whisper model file. Default: auto-detect in ~/.cmd0/models/ */
  modelPath?: string;
  /** For CLI: language code. Default: "en" */
  language?: string;
  /** For API: base URL. Default: "http://localhost:8080" */
  apiUrl?: string;
  /** Timeout in ms. Default: 300000 (5 min) */
  timeout?: number;
  /** Abort signal */
  signal?: AbortSignal;
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

function detectCliBinary(): string | null {
  for (const bin of WHISPER_BINARIES) {
    if (which(bin)) return bin;
  }
  return null;
}

function detectModel(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const modelDirs = [
    path.join(home, ".pi", "models"),
    path.join(home, ".cmd0", "models"),
    path.join(home, ".local", "share", "whisper"),
  ];

  for (const dir of modelDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".bin") || f.endsWith(".ggml"));
    // Prefer base.en model if multiple exist
    const preferred = files.find((f) => f.includes("base.en"));
    if (preferred) return path.join(dir, preferred);
    if (files.length > 0) return path.join(dir, files[0]);
  }
  return null;
}

async function transcribeWithCli(opts: TranscribeOptions): Promise<string> {
  const binary = opts.binaryPath || detectCliBinary();
  if (!binary) {
    throw new Error(
      "whisper-cli not found. Install whisper.cpp:\n  brew install whisper-cpp\nOr set WHISPER_BIN environment variable.",
    );
  }

  const model = opts.modelPath || process.env.WHISPER_MODEL || detectModel();
  if (!model) {
    throw new Error(
      "No whisper model found. Download one:\n" +
      "  mkdir -p ~/.cmd0/models && curl -L -o ~/.cmd0/models/ggml-base.en.bin \\\n" +
      "    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    );
  }

  const language = opts.language || "en";
  const outputTxt = path.join(opts.outputDir, "transcript");

  const args = [
    "-m", model,
    "-f", opts.audioPath,
    "-l", language,
    "--output-txt",
    "--output-file", outputTxt,
    "--no-timestamps",
  ];

  await execFileAsync(binary, args, {
    timeout: opts.timeout || 300_000,
    signal: opts.signal,
  });

  const txtPath = outputTxt + ".txt";
  if (!fs.existsSync(txtPath)) {
    throw new Error(`Transcription output not found at ${txtPath}`);
  }
  return fs.readFileSync(txtPath, "utf-8").trim();
}

async function transcribeWithApi(opts: TranscribeOptions): Promise<string> {
  const baseUrl = opts.apiUrl || process.env.WHISPER_API_URL || "http://localhost:8080";
  const url = `${baseUrl}/v1/audio/transcriptions`;

  // Stream-read the file to avoid loading the entire recording into memory
  const fileBuffer = fs.readFileSync(opts.audioPath);
  const blob = new Blob([fileBuffer], { type: "audio/wav" });

  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", "whisper-1");
  form.append("language", opts.language || "en");
  form.append("response_format", "text");

  const response = await fetch(url, {
    method: "POST",
    body: form,
    signal: opts.signal ?? AbortSignal.timeout(opts.timeout || 300_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Whisper API error ${response.status}: ${body}`);
  }

  return (await response.text()).trim();
}

export async function transcribe(
  opts: TranscribeOptions,
): Promise<{ transcript: string; outputPath: string }> {
  fs.mkdirSync(opts.outputDir, { recursive: true });

  let backend = opts.backend;
  if (!backend) {
    // Auto-detect: try CLI first, then API
    if (detectCliBinary() || opts.binaryPath) {
      backend = "cli";
    } else {
      backend = "api";
    }
  }

  let transcript: string;
  if (backend === "cli") {
    transcript = await transcribeWithCli(opts);
  } else {
    transcript = await transcribeWithApi(opts);
  }

  if (!transcript) {
    throw new Error("Transcription produced empty output. The audio may be silent or too short.");
  }

  const outputPath = path.join(opts.outputDir, "transcript.txt");
  fs.writeFileSync(outputPath, transcript, "utf-8");

  return { transcript, outputPath };
}
