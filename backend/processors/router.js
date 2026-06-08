import { store } from "../store/memory.js";
import { extractLedgerEntryFromText } from "./extract.js";
import { buildPaymentResult } from "./ocr.js";
import { sourceFromMessageType } from "../utils/format.js";

const LEDGER_HINTS = /(paid|payment|received|bheja|mila|jama|transfer|upi|utr|cash|neft|rtgs|cheque|screenshot|goods|stock|supply|supplied|bill|invoice|maal|saman|saaman|bags|cartons|boxes|items|udhar|\u092D\u0941\u0917\u0924\u093E\u0928|\u092A\u0948\u0938\u0947|\u0930\u0941\u092A\u092F\u0947|\u0930\u0915\u094D\u0915\u092E|\u091C\u092E\u093E|\u092E\u093E\u0932|\u0938\u093E\u092E\u093E\u0928|\u092C\u093F\u0932)/i;

export async function processTextMessage(text, context = {}) {
  const routed = routeMessageText(text);

  const phoneUpdate = parsePhoneUpdateMessage(routed.cleanedText) || parsePhoneUpdateMessage(text);
  if (phoneUpdate) {
    const match = store.matchClient(phoneUpdate.clientName);
    if (match.score > 0.6 && match.client) {
      const updatedClient = store.updateClient(match.client.id, {
        phone: phoneUpdate.phoneNumber
      });
      return {
        client_updated: true,
        client: updatedClient,
        extraction: { is_entry: false }
      };
    } else {
      return {
        ignored: true,
        reason: `client_not_found_for_phone_update (name: ${phoneUpdate.clientName})`,
        text
      };
    }
  }

  if (routed.overrideTarget != null) {
    const override = store.approveCreditLimitOverride(routed.overrideTarget, context.sourceNumber);
    if (!override.transaction) {
      return { ignored: true, reason: "override_not_found", override_target: routed.overrideTarget };
    }
    return {
      override: override.alert,
      goods: override.transaction,
      transaction: override.transaction,
      extraction: {
        is_entry: true,
        transaction_type: "goods",
        is_goods: true,
        is_payment: false,
        client_name: override.transaction.client_name,
        amount: override.transaction.amount,
        confidence: 1,
        reason: "credit_limit_override"
      },
      match: { client: store.getClient(override.transaction.client_id), score: 1 }
    };
  }

  if (!routed.isLikelyLedgerEntry) {
    return { ignored: true, reason: "not_ledger_like", text };
  }

  const extraction = await extractLedgerEntryFromText(routed.cleanedText, context);
  if (!extraction.is_entry) {
    return { ignored: true, reason: extraction.reason || "not_ledger_entry", extraction };
  }

  const match = extraction.client_name ? store.matchClient(extraction.client_name) : { client: null, score: 0 };
  let client = match.score > 0.8 ? match.client : null;
  const hasNewKeyword = /^(?:@\s*new|new)\b/i.test(routed.cleanedText);

  if (!client && extraction.client_name) {
    if (hasNewKeyword) {
      let cleanedClientName = extraction.client_name
        .replace(/^@?\s*new\b/i, "")
        .replace(/\s+/g, " ")
        .trim();

      const secondaryMatch = store.matchClient(cleanedClientName);
      if (secondaryMatch.score > 0.8) {
        client = secondaryMatch.client;
        match.score = secondaryMatch.score;
        match.client = client;
      } else {
        client = store.addClient({
          name: cleanedClientName,
          phone: ""
        });
        match.score = 1;
        match.client = client;
      }
    }
  }

  const prefixBoost = routed.businessPrefix && client ? 0.18 : 0;
  const confidence = Math.min(1, (Number(extraction.confidence || 0) + prefixBoost) * (client ? 1 : 0.72));
  let status = confidence >= 0.85 && client ? "confirmed" : "pending_review";
  if (extraction.transaction_type === "goods" && (extraction.credit_days == null || extraction.credit_days === "")) {
    status = "pending_review";
  }

  const base = {
    client_id: client?.id || null,
    client_name: client?.name || extraction.client_name || "Unmatched client",
    amount: extraction.amount,
    recorded_at: extraction.recorded_at || context.timestamp || Date.now(),
    source: sourceFromMessageType(context.messageType || "text"),
    source_number: context.sourceNumber,
    raw_input: text,
    confidence,
    status,
    business_prefix: extraction.business_prefix || routed.businessPrefix || store.getBusiness().prefix,
    match_score: match.score
  };

  if (extraction.transaction_type === "goods") {
    const result = store.addGoods({
      ...base,
      description: extraction.description || text,
      credit_days: extraction.credit_days
    });
    if (result.blocked) {
      return { blocked: true, reason: "credit_limit_exceeded", credit_limit_alert: result.alert, extraction, match };
    }
    return { goods: result.transaction, transaction: result.transaction, extraction, match };
  }

  const payment = store.addPayment({
    ...base,
    mode: extraction.mode,
    utr_number: extraction.utr_number
  });

  return { payment, transaction: payment, extraction, match };
}

export function routeMessageText(text) {
  const original = String(text || "").trim();
  const words = original.split(/\s+/);
  const businessPrefix = store.getBusiness().prefix;
  const firstToken = words[0]?.toUpperCase();
  const hasPrefix = firstToken === businessPrefix;
  const cleanedText = hasPrefix ? words.slice(1).join(" ") : original;
  const overrideMatch = cleanedText.match(/^override\s+(.+?)\s*$/i);
  return {
    businessPrefix: hasPrefix ? businessPrefix : null,
    cleanedText,
    overrideTarget: hasPrefix && overrideMatch ? overrideMatch[1].trim() : null,
    isLikelyLedgerEntry: hasPrefix || LEDGER_HINTS.test(original)
  };
}

export function processImageExtraction(extraction, context = {}) {
  return buildPaymentResult(extraction, context);
}

function parsePhoneUpdateMessage(text) {
  const clean = String(text || "").trim();
  const regex = /^(.*?)\s+\b(phone\s*number|phone|mobile\s*number|mobile|number)\b\s*(?::|=|\s)\s*(\+?[0-9\s-]{10,20})$/i;
  const match = clean.match(regex);
  if (!match) return null;
  return {
    clientName: match[1].trim(),
    phoneNumber: match[3].replace(/[\s-]/g, "")
  };
}
