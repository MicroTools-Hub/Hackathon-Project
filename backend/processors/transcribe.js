import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Groq, { toFile } from "groq-sdk";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
let groqClient;

function getGroqClient() {
  if (!config.groq.apiKey || config.groq.apiKey.includes("your_")) return null;
  if (!groqClient) groqClient = new Groq({ apiKey: config.groq.apiKey });
  return groqClient;
}

export async function transcribeBuffer(buffer, options = {}) {
  const groq = getGroqClient();
  if (groq) {
    try {
      const estimatedSeconds = Math.round(buffer.length / 16000);
      logger.info("Transcribing WhatsApp audio with Groq", { bytes: buffer.length, estimatedSeconds });
      const file = await toFile(buffer, options.filename || `voice-${randomUUID()}.ogg`, {
        type: options.mimeType || "audio/ogg"
      });
      const response = await groq.audio.transcriptions.create({
        file,
        model: config.groq.model,
        language: "hi",
        response_format: "text"
      });
      return { transcript: typeof response === "string" ? response : response.text, provider: "groq" };
    } catch (error) {
      logger.warn("Groq transcription failed; trying whisper.cpp", { error: error.message });
    }
  }

  return transcribeWithWhisperCpp(buffer, options);
}

export async function transcribeAudio(filePath, options = {}) {
  const buffer = await fs.readFile(filePath);
  return transcribeBuffer(buffer, { ...options, filename: options.filename || path.basename(filePath) });
}

async function transcribeWithWhisperCpp(buffer, options = {}) {
  const id = randomUUID();
  const tempDir = os.tmpdir();
  const input = path.join(tempDir, `wl-audio-${id}.ogg`);
  const wav = path.join(tempDir, `wl-audio-${id}.wav`);
  const outputPrefix = path.join(tempDir, `wl-audio-${id}`);
  const outputTxt = `${outputPrefix}.txt`;

  try {
    await fs.access(config.whisperCpp.binaryPath);
    await fs.access(config.whisperCpp.modelPath);
    await fs.writeFile(input, buffer);
    await execFileAsync("ffmpeg", ["-y", "-i", input, "-ar", "16000", "-ac", "1", wav], { windowsHide: true });
    await execFileAsync(config.whisperCpp.binaryPath, ["-m", config.whisperCpp.modelPath, "-l", "hi", "-f", wav, "-otxt", "-of", outputPrefix], { windowsHide: true });
    const transcript = await fs.readFile(outputTxt, "utf8");
    return { transcript: transcript.trim(), provider: "whisper.cpp" };
  } catch (error) {
    logger.error("Transcription failed", { error: error.message });
    return { transcript: null, error: "transcription_failed", provider: getGroqClient() ? "groq+whisper.cpp" : "whisper.cpp" };
  } finally {
    await Promise.all([input, wav, outputTxt].map((file) => fs.rm(file, { force: true }).catch(() => {})));
  }
}
