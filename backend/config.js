import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_FRONTEND_URL = "https://hackathon-project-bice-tau.vercel.app";

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function list(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveFromBackend(value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(__dirname, value);
}

export const config = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "0.0.0.0",
  frontendOrigin: process.env.FRONTEND_ORIGIN || process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL,
  frontendOrigins: list(process.env.FRONTEND_ORIGIN || process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL),
  frontendUrl: process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL,
  allowGroups: bool(process.env.ALLOW_GROUPS, false),
  startWhatsApp: bool(process.env.START_WHATSAPP, true),
  demoMode: bool(process.env.DEMO_MODE, false),
  ownerNumber: process.env.OWNER_NUMBER || list(process.env.TRUSTED_NUMBERS || "+919876500001")[0] || "",
  business: {
    name: process.env.BUSINESS_NAME || "Ramesh Traders",
    prefix: (process.env.BUSINESS_PREFIX || "RAM").toUpperCase()
  },
  trustedNumbers: list(process.env.TRUSTED_NUMBERS || "+919876500001,+919876500002"),
  sessionDir: resolveFromBackend(process.env.SESSION_DIR || "./sessions"),
  uploadsDir: resolveFromBackend(process.env.UPLOADS_DIR || "./uploads"),
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash"
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || "",
    model: process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo"
  },
  whisperCpp: {
    binaryPath: resolveFromBackend(process.env.WHISPER_CPP_PATH || "./whisper.cpp/main"),
    modelPath: resolveFromBackend(process.env.WHISPER_CPP_MODEL || "./models/ggml-base.bin")
  },
  queue: {
    concurrency: Number(process.env.PROCESSING_CONCURRENCY || 1),
    intervalCap: Number(process.env.PROCESSING_INTERVAL_CAP || 12),
    interval: Number(process.env.PROCESSING_INTERVAL_MS || 60000)
  },
  supabase: {
    url: process.env.SUPABASE_URL || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  }
};
