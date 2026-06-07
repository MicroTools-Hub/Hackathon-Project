import PQueue from "p-queue";
import { downloadMediaMessage, getContentType, isLidUser } from "@whiskeysockets/baileys";
import pino from "pino";
import { config } from "../config.js";
import { store } from "../store/memory.js";
import { sseManager } from "../sse/manager.js";
import { processTextMessage } from "../processors/router.js";
import { transcribeBuffer } from "../processors/transcribe.js";
import { extractPaymentFromImageBuffer, buildPaymentResult } from "../processors/ocr.js";
import { jidToPhone } from "../utils/format.js";
import { logger } from "../utils/logger.js";
import { sendAck, sendOwnerAlert } from "./sender.js";
import { resolveLidToPhone } from "./client.js";

const queue = new PQueue({
  concurrency: config.queue.concurrency,
  intervalCap: config.queue.intervalCap,
  interval: config.queue.interval,
  carryoverConcurrencyCount: true
});
const mediaLogger = pino({ level: "silent" });

export async function handleIncomingMessages(sock, event) {
  logger.info("WhatsApp messages event", {
    type: event.type,
    count: event.messages?.length || 0
  });
  if (event.type !== "notify") return;
  for (const message of event.messages || []) {
    await handleSingleMessage(sock, message);
  }
}

async function handleSingleMessage(sock, message) {
  if (!message?.message) {
    logger.info("Ignoring WhatsApp event without message body", { id: message?.key?.id });
    return;
  }
  const content = unwrapMessage(message.message);
  const contentType = getContentType(content);
  const supportedTypes = ["conversation", "extendedTextMessage", "audioMessage", "imageMessage", "documentMessage"];
  if (!contentType || !supportedTypes.includes(contentType)) {
    return;
  }
  const remoteJid = message.key?.remoteJid || "";
  if (remoteJid === "status@broadcast") return;
  const isGroup = remoteJid.endsWith("@g.us");
  if (isGroup && !config.allowGroups) {
    logger.info("Ignoring WhatsApp group message because ALLOW_GROUPS=false", { remoteJid });
    return;
  }

  /* ── Resolve LID JIDs to phone numbers ── */
  let senderJid = isGroup ? (message.key.participant || remoteJid) : remoteJid;
  if (!message.key?.fromMe && isLidUser(senderJid)) {
    const resolved = resolveLidToPhone(senderJid);
    if (resolved) {
      logger.info("Resolved LID to phone", { lid: senderJid.split("@")[0], phone: resolved });
      senderJid = resolved + "@s.whatsapp.net";
    } else {
      logger.warn("Could not resolve LID to phone", { lid: senderJid });
    }
  }

  const sourceNumber = message.key?.fromMe
    ? (sock.user?.id ? jidToPhone(sock.user.id) : "")
    : jidToPhone(senderJid);

  if (message.key?.fromMe) {
    const myJid = sock.user?.id ? sock.user.id.split("@")[0].split(":")[0] : "";
    const remoteJidDigits = remoteJid.split("@")[0].split(":")[0];
    const isSelfChat = myJid && remoteJidDigits && myJid === remoteJidDigits;
    
    const content = unwrapMessage(message.message);
    const text = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.documentMessage?.caption || "";
    const businessPrefix = store.getBusiness()?.prefix;
    const startsWithPrefix = businessPrefix && text.trim().toUpperCase().startsWith(businessPrefix.toUpperCase());
    
    if (!isSelfChat && !startsWithPrefix) {
      logger.info("Ignoring WhatsApp message sent by linked account (not self-chat and doesn't start with prefix)", { id: message.key?.id });
      return;
    }
    if (text.includes("WholesaleLedger")) {
      logger.info("Ignoring bot's own ACK message in self-chat", { id: message.key?.id });
      return;
    }
  }

  if (!store.isTrustedNumber(sourceNumber)) {
    logger.info("Ignoring WhatsApp message from untrusted number", {
      sourceNumber,
      trustedNumbers: store.listTrustedNumbers()
    });
    return;
  }

  await queue.add(async () => {
    const content = unwrapMessage(message.message);
    const contentType = getContentType(content);
    const preview = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.documentMessage?.caption || "";
    logger.info("Processing trusted WhatsApp message", {
      sourceNumber,
      contentType,
      preview: preview.slice(0, 120)
    });
    store.touchTrustedNumber(sourceNumber);
    const context = {
      sourceNumber,
      messageId: message.key.id,
      timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000
    };

    try {
      let result = null;

      if (contentType === "conversation" || contentType === "extendedTextMessage") {
        const text = content.conversation || content.extendedTextMessage?.text || "";
        result = await processTextMessage(text, { ...context, messageType: "text" });
      } else if (contentType === "audioMessage") {
        const audio = await downloadMedia(sock, message, "audio/ogg");
        const transcript = await transcribeBuffer(audio.buffer, { filename: `${message.key.id}.ogg`, mimeType: audio.mimeType });
        if (!transcript.transcript) {
          sseManager.error({ message: "Audio transcription failed", source_number: sourceNumber, raw_input: "" });
          return;
        }
        result = await processTextMessage(transcript.transcript, { ...context, messageType: "audio" });
      } else if (contentType === "imageMessage") {
        const image = await downloadMedia(sock, message, content.imageMessage?.mimetype);
        const extraction = await extractPaymentFromImageBuffer(image.buffer, {
          ...context,
          caption: content.imageMessage?.caption || "",
          mimeType: image.mimeType
        });
        result = buildPaymentResult(extraction, { ...context, caption: content.imageMessage?.caption || "" });
      } else if (contentType === "documentMessage" && /^image\//i.test(content.documentMessage?.mimetype || "")) {
        const image = await downloadMedia(sock, message, content.documentMessage?.mimetype);
        const extraction = await extractPaymentFromImageBuffer(image.buffer, {
          ...context,
          caption: content.documentMessage?.caption || "",
          mimeType: image.mimeType
        });
        result = buildPaymentResult(extraction, { ...context, caption: content.documentMessage?.caption || "" });
      }

      if (result?.credit_limit_alert) {
        sseManager.creditAlert(result.credit_limit_alert);
        await sendOwnerAlert(result.credit_limit_alert).catch((error) => {
          logger.warn("Credit limit owner alert could not be sent", { error: error.message });
        });
      }
      if (result?.override) {
        sseManager.creditAlert(result.override);
      }

      if (result?.payment) {
        sseManager.payment(transactionToEvent(result.payment));
        maybeBroadcastRatingAlert(result.payment);
        await sendAck(message.key, ackPayload(result));
        logger.info("WhatsApp payment recorded", {
          sourceNumber,
          clientName: result.payment.client_name,
          amount: result.payment.amount,
          status: result.payment.status
        });
      } else if (result?.goods) {
        sseManager.transaction(transactionToEvent(result.goods));
        maybeBroadcastRatingAlert(result.goods);
        await sendAck(message.key, ackPayload(result));
        logger.info("WhatsApp goods recorded", {
          sourceNumber,
          clientName: result.goods.client_name,
          amount: result.goods.amount,
          status: result.goods.status
        });
      } else if (result?.ignored) {
        logger.info("WhatsApp message ignored after parsing", {
          sourceNumber,
          reason: result.reason,
          text: result.text || preview
        });
      }

      await sock.readMessages([message.key]).catch(() => {});
    } catch (error) {
      logger.error("WhatsApp message processing failed", { error: error.message, sourceNumber });
      sseManager.error({ message: error.message, source_number: sourceNumber, raw_input: "" });
    }
  });
}

function unwrapMessage(message) {
  let current = message;
  while (current?.ephemeralMessage?.message || current?.viewOnceMessage?.message || current?.viewOnceMessageV2?.message) {
    current = current.ephemeralMessage?.message || current.viewOnceMessage?.message || current.viewOnceMessageV2?.message;
  }
  return current || {};
}

async function downloadMedia(sock, message, fallbackMimeType) {
  const buffer = await downloadMediaMessage(
    message,
    "buffer",
    {},
    {
      logger: mediaLogger,
      reuploadRequest: sock.updateMediaMessage
    }
  );
  const content = unwrapMessage(message.message);
  const type = getContentType(content);
  const mimeType = content[type]?.mimetype || fallbackMimeType || "application/octet-stream";
  return { buffer, mimeType };
}

function transactionToEvent(transaction) {
  return {
    transaction_id: transaction.id,
    payment_id: transaction.type === "payment" ? transaction.id : undefined,
    client_name: transaction.client_name || store.getClient(transaction.client_id)?.name || "Unmatched client",
    client_id: transaction.client_id,
    type: transaction.type,
    amount: transaction.amount,
    mode: transaction.mode,
    description: transaction.description,
    recorded_at: transaction.recorded_at,
    source: transaction.source,
    source_number: transaction.source_number,
    raw_input: transaction.raw_input,
    confidence: transaction.confidence,
    status: transaction.status,
    utr_number: transaction.utr_number,
    business_prefix: transaction.business_prefix,
    balance_before: transaction.balance_before,
    balance_after: transaction.balance_after,
    due_date_at_transaction: transaction.due_date_at_transaction,
    credit_days: transaction.credit_days
  };
}

function ackPayload(result) {
  const transaction = result.transaction || result.payment || result.goods || {};
  return {
    ...(result.extraction || {}),
    is_payment: transaction.type === "payment",
    is_goods: transaction.type === "goods",
    transaction_type: transaction.type,
    transaction_id: transaction.id,
    payment_id: transaction.type === "payment" ? transaction.id : undefined,
    client_name: transaction.client_name,
    amount: transaction.amount,
    mode: transaction.mode,
    confidence: transaction.confidence
  };
}

function maybeBroadcastRatingAlert(transaction) {
  if (!transaction.rating_result?.dropped_to_risky) return;
  const client = transaction.client_id ? store.getClient(transaction.client_id) : null;
  sseManager.ratingAlert({
    client_id: client?.id || transaction.client_id,
    client_name: client?.name || transaction.client_name,
    rating: client?.rating || "risky",
    rating_score: client?.rating_score ?? transaction.rating_result.rating_score,
    transaction_id: transaction.id
  });
}
