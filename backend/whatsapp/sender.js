import { getWhatsAppSocket } from "./client.js";
import { config } from "../config.js";
import { store } from "../store/memory.js";
import { formatINR, normalizePhone } from "../utils/format.js";

export async function sendReminderMessage(phone, text) {
  const sock = getWhatsAppSocket();
  if (!sock) {
    throw Object.assign(new Error("WhatsApp socket is not connected"), { status: 503 });
  }
  const normalized = normalizePhone(phone).replace(/\D/g, "");
  const jid = `${normalized}@s.whatsapp.net`;
  const result = await sock.sendMessage(jid, { text });
  return {
    jid,
    message_id: result?.key?.id || null
  };
}

export async function sendReminder(phone, data = {}) {
  const businessName = data.business_name || store.getBusiness().name;
  const clientName = data.client_name || "customer";
  const amount = data.amount ? formatINR(data.amount) : "your outstanding balance";
  const dueDate = data.due_date ? ` Due date: ${data.due_date}.` : "";
  const text = data.text || `Namaste ${clientName} ji, this is ${businessName}. Please clear ${amount}.${dueDate} Thank you.`;
  const result = await sendReminderMessage(phone, text);
  return { ...result, text };
}

export async function sendOwnerAlert(alert = {}) {
  const owner = normalizePhone(store.getBusiness().owner_number || config.ownerNumber || store.listTrustedNumbers()[0]);
  if (!owner) return { skipped: true, reason: "owner_number_missing" };
  const text = alert.message || String(alert.text || "WholesaleLedger owner alert");
  return sendReminderMessage(owner, text);
}

export async function sendAck(key, extractionResult = {}) {
  if (!key?.remoteJid) return { skipped: true, reason: "missing_jid" };
  if (!extractionResult?.is_payment && !extractionResult?.is_goods && !extractionResult?.transaction_id && !extractionResult?.payment_id && !extractionResult?.amount) {
    return { skipped: true, reason: "not_ledger_entry" };
  }

  const sock = getWhatsAppSocket();
  if (!sock) {
    return { skipped: true, reason: "socket_not_connected" };
  }

  const clientName = extractionResult.client_name || "client";
  const amount = extractionResult.amount ? formatINR(extractionResult.amount) : "payment";
  const isGoods = extractionResult.is_goods || extractionResult.transaction_type === "goods";
  const mode = !isGoods && extractionResult.mode ? ` by ${String(extractionResult.mode).toUpperCase()}` : "";
  const status = extractionResult.status || "confirmed";
  const reason = extractionResult.review_reason || "unknown reason";
  const reviewLine = status === "confirmed"
    ? "Entry confirmed in WholesaleLedger."
    : `Entry is pending for review because - ${reason}.`;
  const text = isGoods
    ? `Recorded goods: ${amount} for ${clientName}.\n${reviewLine}`
    : `Received: ${amount}${mode} from ${clientName}.\n${reviewLine}`;
  const result = await sock.sendMessage(key.remoteJid, { text });

  return {
    jid: key.remoteJid,
    message_id: result?.key?.id || null
  };
}
