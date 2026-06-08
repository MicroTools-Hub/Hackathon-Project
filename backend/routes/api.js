import express from "express";
import multer from "multer";
import { config } from "../config.js";
import { store } from "../store/memory.js";
import { sseManager } from "../sse/manager.js";
import { processTextMessage } from "../processors/router.js";
import { transcribeAudio } from "../processors/transcribe.js";
import { ocrPaymentImage } from "../processors/ocr.js";
import { geminiQueue } from "../processors/queue.js";
import { getLatestQrDataUrl, getWhatsAppStatus } from "../whatsapp/client.js";
import { sendOwnerAlert, sendReminder, sendReminderMessage } from "../whatsapp/sender.js";
import { normalizePhone } from "../utils/format.js";

const upload = multer({
  dest: config.uploadsDir,
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

export function createApiRouter() {
  const router = express.Router();

  router.get("/health", (req, res) => {
    res.json({
      ok: true,
      app: "WholesaleLedger backend",
      time: new Date().toISOString(),
      sse_clients: sseManager.count(),
      whatsapp: whatsappStatusLabel()
    });
  });

  router.get("/status", (req, res) => {
    res.json({
      business: store.getBusiness(),
      stats: store.getStats(),
      trusted_numbers: store.listTrustedNumbers(),
      connection_events: store.listConnectionEvents(),
      whatsapp: whatsappStatusLabel(),
      sse_clients: sseManager.count(),
      queue_size: queueSize(),
      uptime: process.uptime()
    });
  });

  router.get("/qr", (req, res) => {
    res.json({
      status: whatsappStatusLabel(),
      qr: getLatestQrDataUrl(),
      image: getLatestQrDataUrl()
    });
  });

  router.get("/qr-page", (req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WholesaleLedger WhatsApp QR</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; background: #111; color: #f8f8f8; }
    main { width: min(92vw, 440px); text-align: center; }
    img { width: min(82vw, 320px); height: min(82vw, 320px); background: white; border: 12px solid white; border-radius: 8px; }
    .status { margin: 14px 0 6px; font-weight: 700; }
    .hint { color: #c8c8c8; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <h1>WhatsApp QR</h1>
    <div id="slot"><p>Loading QR...</p></div>
    <p class="status" id="status">Checking...</p>
    <p class="hint">Scan from WhatsApp > Linked devices > Link a device. This page refreshes the QR automatically.</p>
  </main>
  <script>
    async function refreshQr() {
      const response = await fetch("/api/qr").catch(() => null);
      if (!response) return;
      const data = await response.json();
      document.getElementById("status").textContent = data.status || "unknown";
      document.getElementById("slot").innerHTML = data.qr
        ? '<img src="' + data.qr + '" alt="WhatsApp QR">'
        : '<p>No QR available. Restart backend with START_WHATSAPP=true.</p>';
      if (data.status === "connected") document.getElementById("status").textContent = "connected";
    }
    refreshQr();
    setInterval(refreshQr, 2000);
  </script>
</body>
</html>`);
  });

  router.get("/sse", (req, res) => {
    sseManager.attach(req, res);
  });

  router.get("/clients", (req, res) => {
    res.json({ clients: store.listClients() });
  });

  router.post("/clients", (req, res) => {
    if (!req.body?.name) return res.status(400).json({ error: "name_required" });
    const client = store.addClient(req.body);
    res.status(201).json({ client });
  });

  router.get("/transactions", (req, res) => {
    res.json({
      transactions: store.listTransactions({
        type: req.query.type,
        client_id: req.query.client_id,
        status: req.query.status,
        limit: req.query.limit
      })
    });
  });

  router.post("/transactions", async (req, res, next) => {
    try {
      const result = store.addTransaction({
        ...req.body,
        source: req.body.source || "manual",
        source_number: req.body.source_number || "manual",
        confidence: req.body.confidence ?? 1,
        status: req.body.status || "confirmed"
      });
      if (result.blocked) return sendCreditLimitResponse(res, result.alert);
      broadcastTransaction(result.transaction);
      res.status(201).json({ transaction: result.transaction });
    } catch (error) {
      next(error);
    }
  });

  router.put("/transactions/:id/confirm", (req, res) => {
    const result = store.confirmTransaction(req.params.id, req.body || {});
    if (!result.transaction) return res.status(404).json({ error: "transaction_not_found" });
    if (result.blocked) return sendCreditLimitResponse(res, result.alert);
    broadcastTransaction(result.transaction);
    res.json({ transaction: result.transaction });
  });

  router.delete("/transactions/:id", (req, res) => {
    const transaction = store.deleteTransaction(req.params.id);
    if (!transaction) return res.status(404).json({ error: "transaction_not_found" });
    sseManager.broadcast({ type: "transaction_deleted", data: { transaction_id: transaction.id, type: transaction.type } });
    res.json({ ok: true, transaction });
  });

  router.get("/goods", (req, res) => {
    res.json({
      goods: store.listTransactions({
        type: "goods",
        client_id: req.query.client_id,
        status: req.query.status,
        limit: req.query.limit
      })
    });
  });

  router.post("/goods", async (req, res, next) => {
    try {
      const result = store.addGoods({
        ...req.body,
        source: req.body.source || "manual",
        source_number: req.body.source_number || "manual",
        confidence: req.body.confidence ?? 1,
        status: req.body.status || "confirmed"
      });
      if (result.blocked) return sendCreditLimitResponse(res, result.alert);
      broadcastTransaction(result.transaction);
      res.status(201).json({ goods: result.transaction, transaction: result.transaction });
    } catch (error) {
      next(error);
    }
  });

  router.get("/credit-limit-alerts", (req, res) => {
    res.json({
      alerts: store.listCreditLimitAlerts({
        status: req.query.status,
        client_id: req.query.client_id,
        limit: req.query.limit
      })
    });
  });

  router.post("/credit-limit-alerts/:id/approve", (req, res) => {
    const result = store.approveCreditLimitOverride(req.params.id, req.body?.approved_by || "api");
    if (!result.transaction) return res.status(404).json({ error: "credit_limit_alert_not_found" });
    sseManager.creditAlert(result.alert);
    broadcastTransaction(result.transaction);
    res.json({ ok: true, alert: result.alert, transaction: result.transaction });
  });

  router.get("/payments", (req, res) => {
    res.json({
      payments: store.listPayments({
        client_id: req.query.client_id,
        status: req.query.status,
        limit: req.query.limit
      })
    });
  });

  router.post("/payments", (req, res) => {
    const payment = store.addPayment({
      ...req.body,
      source: req.body.source || "manual",
      source_number: req.body.source_number || "manual",
      confidence: req.body.confidence ?? 1,
      status: req.body.status || "confirmed"
    });
    broadcastTransaction(payment);
    res.status(201).json({ payment });
  });

  router.put("/payments/:id/confirm", (req, res) => {
    const existing = store.getPayment(req.params.id);
    if (!existing) return res.status(404).json({ error: "payment_not_found" });
    const payment = store.updatePayment(req.params.id, {
      ...req.body,
      status: "confirmed",
      confidence: Math.max(Number(req.body.confidence ?? existing.confidence ?? 0), 0.85)
    });
    broadcastTransaction(payment);
    res.json({ payment });
  });

  router.delete("/payments/:id", (req, res) => {
    const payment = store.deletePayment(req.params.id);
    if (!payment) return res.status(404).json({ error: "payment_not_found" });
    sseManager.broadcast({ type: "payment_deleted", data: { payment_id: payment.id, transaction_id: payment.id } });
    res.json({ ok: true, payment });
  });

  router.get("/trusted-numbers", (req, res) => {
    res.json({ trusted_numbers: store.listTrustedNumbers() });
  });

  router.put("/trusted-numbers", (req, res) => {
    const trustedNumbers = store.setTrustedNumbers(req.body.trusted_numbers || []);
    res.json({ trusted_numbers: trustedNumbers });
  });

  router.post("/trusted-numbers", (req, res) => {
    if (!req.body?.phone) return res.status(400).json({ error: "phone_required" });
    const { phone, label } = req.body;
    res.status(201).json({ trusted_numbers: store.addTrustedNumber(phone, label) });
  });

  router.put("/trusted-numbers/:phone/toggle", (req, res) => {
    const { active } = req.body;
    res.json({ trusted_numbers: store.toggleTrustedNumber(req.params.phone, active) });
  });

  router.delete("/trusted-numbers/:phone", (req, res) => {
    res.json({ trusted_numbers: store.removeTrustedNumber(req.params.phone) });
  });

  router.get("/business", (req, res) => {
    res.json({ business: store.getBusiness() });
  });

  router.put("/business", (req, res) => {
    res.json({ business: store.updateBusiness(req.body || {}) });
  });

  router.post("/reset", (req, res) => {
    store.resetDb();
    res.json({ ok: true });
  });

  router.post("/test/text", async (req, res, next) => {
    try {
      const text = String(req.body.text || "");
      const sourceNumber = normalizePhone(req.body.source_number || store.listTrustedNumbers()[0] || "+919876500001");
      const result = await processTextMessage(text, {
        sourceNumber,
        messageType: "text",
        messageId: `test-${Date.now()}`,
        timestamp: Date.now()
      });
      await broadcastProcessingResult(result);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/test/payment", (req, res) => {
    const payment = createFakePayment(req.body || {});
    broadcastTransaction(payment);
    res.status(201).json({ payment });
  });

  router.post("/test/goods", async (req, res, next) => {
    try {
      const result = createFakeGoods(req.body || {});
      if (result.blocked) return sendCreditLimitResponse(res, result.alert);
      broadcastTransaction(result.transaction);
      res.status(201).json({ goods: result.transaction, transaction: result.transaction });
    } catch (error) {
      next(error);
    }
  });

  router.post("/test-sse", (req, res) => {
    const payment = createFakePayment(req.body || {});
    broadcastTransaction(payment);
    res.status(201).json({ ok: true, payment });
  });

  router.post("/test/audio", upload.single("audio"), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "audio_required" });
      const transcript = await transcribeAudio(req.file.path, {
        filename: req.file.originalname,
        mimeType: req.file.mimetype
      });
      if (!transcript.transcript) return res.status(422).json(transcript);
      const result = await processTextMessage(transcript.transcript, {
        sourceNumber: normalizePhone(req.body.source_number || store.listTrustedNumbers()[0]),
        messageType: "audio",
        messageId: `audio-test-${Date.now()}`,
        timestamp: Date.now()
      });
      await broadcastProcessingResult(result);
      res.json({ transcript, result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/test/image", upload.single("image"), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "image_required" });
      const result = await ocrPaymentImage(req.file.path, {
        caption: req.body.caption || "",
        sourceNumber: normalizePhone(req.body.source_number || store.listTrustedNumbers()[0]),
        mimeType: req.file.mimetype,
        messageId: `image-test-${Date.now()}`
      });
      if (result?.payment) broadcastTransaction(result.payment);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/send-reminder", async (req, res, next) => {
    try {
      const client = req.body.client_id ? store.getClient(req.body.client_id) : null;
      const phone = normalizePhone(req.body.client_phone || req.body.phone || client?.phone);
      if (!phone) return res.status(400).json({ error: "phone_required" });

      let result;
      let text = req.body.text;
      if (text) {
        result = await sendReminderMessage(phone, text);
      } else {
        result = await sendReminder(phone, {
          client_name: req.body.client_name || client?.name,
          amount: req.body.amount || client?.running_balance,
          business_name: req.body.business_name || store.getBusiness().name,
          due_date: req.body.due_date || (client?.due_date ? new Date(client.due_date).toLocaleDateString("en-IN") : "")
        });
        text = result.text;
      }

      if (client) store.markReminderSent(client.id);
      sseManager.reminder({ phone, client_name: client?.name || req.body.client_name || "", text, result });
      res.json({ ok: true, result });
    } catch (error) {
      next(error);
    }
  });

  router.use((error, req, res, next) => {
    const payload = {
      message: error.message,
      path: req.path
    };
    sseManager.error(payload);
    res.status(error.status || 500).json({ error: "backend_error", ...payload });
  });

  return router;
}

export function paymentToEvent(payment) {
  return transactionToEvent(payment);
}

export function transactionToEvent(transaction) {
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

async function broadcastProcessingResult(result) {
  if (result?.credit_limit_alert) {
    sseManager.creditAlert(result.credit_limit_alert);
    await sendOwnerAlert(result.credit_limit_alert).catch(() => {});
  }
  if (result?.override) sseManager.creditAlert(result.override);
  if (result?.payment) broadcastTransaction(result.payment);
  if (result?.goods) broadcastTransaction(result.goods);
}

function broadcastTransaction(transaction) {
  if (transaction.type === "payment") sseManager.payment(paymentToEvent(transaction));
  else sseManager.transaction(transactionToEvent(transaction));
  maybeBroadcastRatingAlert(transaction);
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

function sendCreditLimitResponse(res, alert) {
  sseManager.creditAlert(alert);
  sendOwnerAlert(alert).catch(() => {});
  return res.status(409).json({ error: "credit_limit_exceeded", alert });
}

function createFakePayment(input = {}) {
  const client = pickClient(input);
  const clientMatch = input.client_name ? store.matchClient(input.client_name) : { client, score: client ? 1 : 0 };
  const matchedClient = input.client_id ? store.getClient(input.client_id) : (clientMatch.score > 0.8 ? clientMatch.client : client);
  const confidence = Number(input.confidence ?? (Math.random() > 0.25 ? 0.92 : 0.72));
  return store.addPayment({
    client_id: input.client_id || matchedClient?.id || null,
    client_name: input.client_name || matchedClient?.name || "Test Client",
    amount: Number(input.amount || randomFrom([2500, 5000, 8000, 12000, 15000, 25000])),
    mode: input.mode || randomFrom(["upi", "cash", "neft", "rtgs"]),
    recorded_at: Date.now(),
    source: input.source || randomFrom(["whatsapp_text", "whatsapp_voice", "whatsapp_image"]),
    source_number: input.source_number || store.listTrustedNumbers()[0],
    raw_input: input.raw_input || "Test payment event",
    confidence,
    status: confidence >= 0.85 && (input.client_id || matchedClient?.id) ? "confirmed" : "pending_review",
    utr_number: input.utr_number || (Math.random() > 0.5 ? `UPI${Math.floor(100000 + Math.random() * 899999)}` : null),
    match_score: clientMatch.score
  });
}

function createFakeGoods(input = {}) {
  const client = pickClient(input);
  const matchedClient = input.client_id ? store.getClient(input.client_id) : client;
  const confidence = Number(input.confidence ?? 0.94);
  return store.addGoods({
    client_id: input.client_id || matchedClient?.id || null,
    client_name: input.client_name || matchedClient?.name || "Test Client",
    amount: Number(input.amount || randomFrom([10000, 18000, 25000, 35000, 50000])),
    description: input.description || "Test goods entry",
    recorded_at: Date.now(),
    source: input.source || randomFrom(["whatsapp_text", "whatsapp_voice", "manual"]),
    source_number: input.source_number || store.listTrustedNumbers()[0],
    raw_input: input.raw_input || "Test goods event",
    confidence,
    status: confidence >= 0.85 && matchedClient ? "confirmed" : "pending_review",
    match_score: matchedClient ? 1 : 0,
    override_credit_limit: Boolean(input.override_credit_limit)
  });
}

function pickClient(input = {}) {
  if (input.client_id) return store.getClient(input.client_id);
  const clients = store.listClients();
  if (!clients.length) return null;
  return clients[Math.floor(Math.random() * clients.length)];
}

function randomFrom(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function whatsappStatusLabel() {
  const status = getWhatsAppStatus();
  if (status.connected) return "connected";
  if (status.qr_pending) return "qr_pending";
  return "disconnected";
}

function queueSize() {
  return Number(geminiQueue.size || 0) + Number(geminiQueue.pending || 0);
}
