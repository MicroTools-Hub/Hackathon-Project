import { store } from "../store/memory.js";
import { extractLedgerEntryFromText } from "./extract.js";
import { buildPaymentResult } from "./ocr.js";
import { sourceFromMessageType } from "../utils/format.js";

const LEDGER_HINTS = /(paid|payment|received|bheja|mila|jama|transfer|upi|utr|cash|neft|rtgs|cheque|screenshot|goods|stock|supply|supplied|bill|invoice|maal|saman|saaman|bags|cartons|boxes|items|udhar|\u092D\u0941\u0917\u0924\u093E\u0928|\u092A\u0948\u0938\u0947|\u0930\u0941\u092A\u092F\u0947|\u0930\u0915\u094D\u0915\u092E|\u091C\u092E\u093E|\u092E\u093E\u0932|\u0938\u093E\u092E\u093E\u0928|\u092C\u093F\u0932)/i;

export async function processTextMessage(text, context = {}) {
  const routed = routeMessageText(text);
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
  const client = match.score > 0.8 ? match.client : null;
  const prefixBoost = routed.businessPrefix && client ? 0.18 : 0;
  const confidence = Math.min(1, (Number(extraction.confidence || 0) + prefixBoost) * (client ? 1 : 0.72));
  const status = confidence >= 0.85 && client ? "confirmed" : "pending_review";
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
      description: extraction.description || text
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
