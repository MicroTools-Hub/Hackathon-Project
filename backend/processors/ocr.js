import fs from "node:fs/promises";
import sharp from "sharp";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";
import { store } from "../store/memory.js";
import { sanitizeExtraction, heuristicExtract, callGeminiForJson } from "./extract.js";
import { logger } from "../utils/logger.js";

let visionModel;

function getVisionModel() {
  if (!config.gemini.apiKey || config.gemini.apiKey.includes("your_")) return null;
  if (!visionModel) {
    const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
    visionModel = genAI.getGenerativeModel({
      model: config.gemini.model,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    });
  }
  return visionModel;
}

export async function extractPaymentFromImageBuffer(buffer, context = {}) {
  const model = getVisionModel();
  if (!model) {
    return heuristicExtract(context.caption || "", context, "gemini_vision_not_configured");
  }

  const prepared = await sharp(buffer)
    .rotate()
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  const prompt = `You are reading a UPI or bank payment screenshot for ${store.getBusiness().name}.
Known clients: ${store.listClients().map((client) => client.name).join(", ")}
Caption: ${context.caption || ""}

Return valid JSON only:
{
  "is_payment": boolean,
  "payer_name": string | null,
  "client_name": string | null,
  "amount": number | null,
  "mode": "cash" | "upi" | "neft" | "rtgs" | "cheque" | "unknown",
  "recorded_at": number | null,
  "utr_number": string | null,
  "business_prefix": string | null,
  "notes": string,
  "confidence": number,
  "reason": string
}

Extract payer/client, credited amount, UTR/reference number, and payment mode from the screenshot. Use payer_name for the name visible in the payment screenshot.`;

  try {
    const contents = [
      prompt,
      { inlineData: { data: prepared.toString("base64"), mimeType: "image/jpeg" } }
    ];
    const retryContents = [
      `${prompt}\n\nReturn ONLY valid JSON, nothing else, no backticks.`,
      contents[1]
    ];
    const parsed = await callGeminiForJson(model, contents, retryContents);
    if (parsed?.error === "parse_failed") return parsed;
    return sanitizeExtraction(parsed, context.caption || "UPI screenshot");
  } catch (error) {
    logger.warn("Gemini OCR failed; using caption heuristic", { error: error.message });
    return heuristicExtract(context.caption || "", context, "gemini_vision_failed");
  }
}

export async function ocrPaymentImage(filePath, context = {}) {
  const buffer = await fs.readFile(filePath);
  const extraction = await extractPaymentFromImageBuffer(buffer, context);
  return buildPaymentResult(extraction, context);
}

export function buildPaymentResult(extraction, context = {}) {
  if (!extraction.is_payment) {
    return { ignored: true, reason: extraction.reason || "not_payment", extraction };
  }
  const match = extraction.client_name ? store.matchClient(extraction.client_name) : { client: null, score: 0 };
  const client = match.score > 0.8 ? match.client : null;
  const confidence = Math.min(1, Number(extraction.confidence || 0) * (client ? 1 : 0.72));
  const payment = store.addPayment({
    client_id: client?.id || null,
    client_name: client?.name || extraction.client_name || "Unmatched client",
    amount: extraction.amount,
    mode: extraction.mode,
    recorded_at: extraction.recorded_at || context.timestamp || Date.now(),
    source: "whatsapp_image",
    source_number: context.sourceNumber,
    raw_input: context.caption || "UPI screenshot",
    confidence,
    status: confidence >= 0.85 && client ? "confirmed" : "pending_review",
    utr_number: extraction.utr_number,
    business_prefix: extraction.business_prefix || store.getBusiness().prefix,
    match_score: match.score
  });
  return { payment, extraction, match };
}
