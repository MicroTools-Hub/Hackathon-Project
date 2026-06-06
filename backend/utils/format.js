export function normalizePhone(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

export function jidToPhone(jid) {
  const cleanJid = String(jid || "").split("@")[0].split(":")[0];
  return normalizePhone(cleanJid);
}

export function formatINR(amount, symbol = "\u20B9") {
  const value = Number(amount) || 0;
  return `${symbol}${Math.round(value).toLocaleString("en-IN")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function parseAmount(value) {
  if (typeof value === "number") return value;
  const cleaned = String(value || "")
    .replace(/,/g, "")
    .replace(/[\u20B9 rsinr]/gi, "")
    .trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function inferMode(text) {
  const value = String(text || "").toLowerCase();
  if (/\bupi\b|gpay|phonepe|paytm|utr|imps/.test(value)) return "upi";
  if (/\bcash\b|\u0928\u0915\u0926|\u0930\u094B\u0916|cash mila|cash received/.test(value)) return "cash";
  if (/\bneft\b/.test(value)) return "neft";
  if (/\brtgs\b/.test(value)) return "rtgs";
  if (/\bcheque\b|check|\u091A\u0947\u0915/.test(value)) return "cheque";
  return "unknown";
}

export function sourceFromMessageType(type) {
  if (type === "audio") return "whatsapp_voice";
  if (type === "image") return "whatsapp_image";
  return "whatsapp_text";
}
