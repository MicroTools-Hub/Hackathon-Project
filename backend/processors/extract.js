import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";
import { store } from "../store/memory.js";
import { inferMode, parseAmount } from "../utils/format.js";
import { logger } from "../utils/logger.js";
import { runGeminiTask } from "./queue.js";

const SYSTEM_CONTEXT = `You are a payment and goods extraction assistant for Indian wholesale businesses.
Messages come from business owners or managers in Hindi, Marathi, English, or a mix.
You understand common Indian business phrases and running-balance wholesale ledgers.
Always respond with valid JSON only. No markdown. No explanation.`;

let model;

function getGeminiModel() {
  if (!config.gemini.apiKey || config.gemini.apiKey.includes("your_")) return null;
  if (!model) {
    const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
    model = genAI.getGenerativeModel({
      model: config.gemini.model,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    });
  }
  return model;
}

export async function extractPaymentFromText(text, context = {}) {
  return extractLedgerEntryFromText(text, context);
}

export async function extractLedgerEntryFromText(text, context = {}) {
  const gemini = getGeminiModel();
  if (!gemini) {
    return heuristicExtract(text, context, "gemini_not_configured");
  }

  const clients = store.listClients().map((client) => client.name);
  const prompt = `${SYSTEM_CONTEXT}

Business name: ${store.getBusiness().name}
Business prefix: ${store.getBusiness().prefix}
Known clients: ${clients.join(", ")}

Extract this WhatsApp message into exactly this JSON shape:
{
  "is_entry": boolean,
  "transaction_type": "payment" | "goods" | null,
  "is_payment": boolean,
  "is_goods": boolean,
  "client_name": string | null,
  "amount": number | null,
  "mode": "cash" | "upi" | "neft" | "rtgs" | "cheque" | "unknown",
  "description": string | null,
  "recorded_at": number | null,
  "utr_number": string | null,
  "business_prefix": string | null,
  "notes": string,
  "confidence": number,
  "reason": string
}

Rules:
- Payment signals: "bheja", "mila", "received", "paid", "jama", "transfer", "UPI screenshot", "cash".
- Goods signals: "maal diya", "saman diya", "goods", "stock", "bags", "cartons", "udhar", "bill", "invoice", "supply".
- Convert Indian amounts written in words or shorthand. "15k" means 15000, "1.15 lakh" means 115000.
- For goods, amount is the value of goods supplied, not quantity.
- Use Unix epoch milliseconds for recorded_at only if the message explicitly gives a date/time; otherwise null.
- If no client can be inferred, client_name must be null and confidence must be below 0.85.
- confidence must be 0 to 1.

Message:
${text}`;

  try {
    const parsed = await callGeminiForJson(gemini, prompt);
    if (parsed?.error === "parse_failed") return parsed;
    return sanitizeExtraction(parsed, text);
  } catch (error) {
    logger.warn("Gemini extraction failed; using heuristic fallback", { error: error.message });
    return heuristicExtract(text, context, "gemini_failed");
  }
}

export function sanitizeExtraction(raw = {}, originalText = "") {
  const amount = parseAmount(raw.amount);
  const transactionType = normalizeTransactionType(
    raw.transaction_type || raw.type || (raw.is_goods ? "goods" : raw.is_payment ? "payment" : inferTransactionType(originalText))
  );
  const confidence = clamp(Number(raw.confidence ?? 0.5), 0, 1);
  const isEntry = Boolean((raw.is_entry || raw.is_payment || raw.is_goods || transactionType) && amount > 0);
  return {
    is_entry: isEntry,
    transaction_type: isEntry ? transactionType : null,
    is_payment: Boolean(isEntry && transactionType === "payment"),
    is_goods: Boolean(isEntry && transactionType === "goods"),
    client_name: raw.client_name || raw.payer_name || null,
    amount: amount || null,
    mode: normalizeMode(raw.mode || inferMode(originalText)),
    description: raw.description || raw.notes || null,
    recorded_at: Number(raw.recorded_at || 0) || null,
    utr_number: raw.utr_number || findUtr(originalText),
    business_prefix: raw.business_prefix ? String(raw.business_prefix).toUpperCase() : extractPrefix(originalText),
    notes: raw.notes || "",
    confidence,
    reason: raw.reason || ""
  };
}

export function heuristicExtract(text, context = {}, reason = "heuristic") {
  const amount = extractAmount(text);
  const client = inferClientName(text);
  const transactionType = inferTransactionType(text);
  const isEntry = amount > 0 && Boolean(transactionType) && isLedgerLike(text);
  return {
    is_entry: isEntry,
    transaction_type: isEntry ? transactionType : null,
    is_payment: isEntry && transactionType === "payment",
    is_goods: isEntry && transactionType === "goods",
    client_name: client,
    amount: amount || null,
    mode: transactionType === "payment" ? inferMode(text) : "unknown",
    description: transactionType === "goods" ? inferDescription(text) : null,
    recorded_at: null,
    utr_number: findUtr(text),
    business_prefix: extractPrefix(text),
    notes: reason,
    confidence: isEntry ? (client ? 0.72 : 0.58) : 0.2,
    reason
  };
}

export function parseJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

export async function callGeminiForJson(model, contents, retryContents) {
  const first = await runGeminiTask(() => model.generateContent(contents));
  try {
    return parseJson(first.response.text());
  } catch (error) {
    logger.warn("Gemini returned invalid JSON; retrying once", { error: error.message });
  }

  let retry;
  try {
    retry = await runGeminiTask(() => model.generateContent(
      retryContents || appendJsonOnlyInstruction(contents)
    ));
  } catch (error) {
    logger.error("Gemini JSON retry request failed", { error: error.message });
    return { is_payment: false, is_entry: false, confidence: 0, error: "parse_failed" };
  }
  try {
    return parseJson(retry.response.text());
  } catch (error) {
    logger.error("Gemini JSON retry failed", { error: error.message });
    return { is_payment: false, is_entry: false, confidence: 0, error: "parse_failed" };
  }
}

function appendJsonOnlyInstruction(contents) {
  const instruction = "Return ONLY valid JSON, nothing else, no backticks.";
  if (typeof contents === "string") return `${contents}\n\n${instruction}`;
  if (Array.isArray(contents)) return [`${contents[0] || ""}\n\n${instruction}`, ...contents.slice(1)];
  return contents;
}

function extractAmount(text) {
  const value = String(text || "").toLowerCase();
  const lakhMatch = value.match(/(\d+(?:\.\d+)?)\s*(?:lakh|lac|\u0932\u093E\u0916)/);
  if (lakhMatch) return Math.round(Number(lakhMatch[1]) * 100000);
  const kMatch = value.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (kMatch) return Math.round(Number(kMatch[1]) * 1000);
  const rupeeMatch = value.match(/(?:\u20B9|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.\d+)?)/i);
  if (rupeeMatch) return parseAmount(rupeeMatch[1]);

  const words = [
    ["pandra", 15000],
    ["pandrah", 15000],
    ["fifteen thousand", 15000],
    ["barah", 12000],
    ["twelve thousand", 12000],
    ["das hazaar", 10000],
    ["ten thousand", 10000],
    ["aath hazaar", 8000],
    ["eight thousand", 8000],
    ["pachis hazaar", 25000],
    ["twenty five thousand", 25000]
  ];
  const match = words.find(([word]) => value.includes(word));
  return match ? match[1] : 0;
}

function inferClientName(text) {
  const value = String(text || "");
  const clients = store.listClients();
  const explicit = clients.find((client) => value.toLowerCase().includes(client.name.toLowerCase()));
  if (explicit) return explicit.name;

  const marker = value.match(/(?:from|se|ne|ka|ke|by|ko|wale|walla)\s+([A-Za-z\u0900-\u097F][A-Za-z0-9\u0900-\u097F &.-]{2,40})/i);
  if (marker) return marker[1].trim();

  const firstTwoWords = value.match(/^([A-Za-z\u0900-\u097F][A-Za-z0-9\u0900-\u097F&.-]+(?:\s+[A-Za-z\u0900-\u097F][A-Za-z0-9\u0900-\u097F&.-]+)?)/);
  return firstTwoWords ? firstTwoWords[1].trim() : null;
}

function inferDescription(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

function isLedgerLike(text) {
  return Boolean(inferTransactionType(text));
}

function inferTransactionType(text) {
  const value = String(text || "").toLowerCase();
  const goods = /(goods|stock|supply|supplied|bill|invoice|maal|saman|saaman|bags|cartons|boxes|items|udhar|\u092E\u093E\u0932|\u0938\u093E\u092E\u093E\u0928|\u092C\u093F\u0932)/i.test(value);
  const payment = /(paid|payment|received|bheja|mila|jama|transfer|upi|utr|cash|neft|rtgs|cheque|screenshot|\u092D\u0941\u0917\u0924\u093E\u0928|\u092A\u0948\u0938\u0947|\u0930\u0941\u092A\u092F\u0947|\u0930\u0915\u094D\u0915\u092E|\u091C\u092E\u093E)/i.test(value);
  if (goods && !payment) return "goods";
  if (payment) return "payment";
  return null;
}

function normalizeTransactionType(type) {
  const value = String(type || "").toLowerCase();
  if (value === "goods" || value === "payment") return value;
  return null;
}

function normalizeMode(mode) {
  const value = String(mode || "").toLowerCase();
  return ["cash", "upi", "neft", "rtgs", "cheque"].includes(value) ? value : "unknown";
}

function findUtr(text) {
  const match = String(text || "").match(/\b(?:UTR|UPI|RRN|REF)[\s:-]*([A-Z0-9]{6,24})\b/i);
  return match ? match[1].toUpperCase() : null;
}

function extractPrefix(text) {
  const businessPrefix = store.getBusiness().prefix;
  const first = String(text || "").trim().split(/\s+/)[0]?.toUpperCase();
  return first === businessPrefix ? businessPrefix : null;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
