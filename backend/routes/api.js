import express from "express";
import multer from "multer";
import { config } from "../config.js";
import { store } from "../store/memory.js";
import { sseManager } from "../sse/manager.js";
import { processTextMessage } from "../processors/router.js";
import { transcribeAudio } from "../processors/transcribe.js";
import { ocrPaymentImage } from "../processors/ocr.js";
import { geminiQueue } from "../processors/queue.js";
import { getLatestQrDataUrl, getWhatsAppStatus, startWhatsAppClient, stopWhatsAppClient } from "../whatsapp/client.js";
import { sendOwnerAlert, sendReminder, sendReminderMessage } from "../whatsapp/sender.js";
import { normalizePhone } from "../utils/format.js";
import { logger } from "../utils/logger.js";

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
  <title>WhatsApp Control Center | WholesaleLedger</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: radial-gradient(circle at top, #141e30, #243b55);
      --card-bg: rgba(255, 255, 255, 0.04);
      --card-border: rgba(255, 255, 255, 0.08);
      --text-primary: #ffffff;
      --text-secondary: #b0c4de;
      --brand-green: #25d366;
      --brand-green-hover: #20ba56;
      --danger-red: #ff4757;
      --danger-red-hover: #ff2e44;
      --glow-color: rgba(37, 211, 102, 0.2);
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Outfit', sans-serif;
      background: #0b0f19;
      background-image: var(--bg-gradient);
      color: var(--text-primary);
      padding: 20px;
    }
    
    .container {
      width: 100%;
      max-width: 480px;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 40px 30px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      text-align: center;
      transition: all 0.3s ease;
    }
    
    h1 {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #fff 0%, var(--text-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }
    
    .subtitle {
      font-size: 15px;
      color: var(--text-secondary);
      margin-bottom: 30px;
      font-weight: 300;
    }
    
    .qr-container {
      position: relative;
      width: 280px;
      height: 280px;
      margin: 0 auto 30px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 20px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.2);
    }
    
    .qr-container.active-qr {
      box-shadow: 0 0 30px var(--glow-color);
      border-color: rgba(37, 211, 102, 0.3);
    }
    
    .qr-image {
      width: 250px;
      height: 250px;
      border-radius: 12px;
      background: white;
      border: 8px solid white;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
      animation: fadeIn 0.5s ease;
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.05);
      padding: 8px 16px;
      border-radius: 30px;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 30px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      text-transform: capitalize;
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #747d8c;
      box-shadow: 0 0 8px #747d8c;
    }
    
    .status-connected .status-dot {
      background: var(--brand-green);
      box-shadow: 0 0 10px var(--brand-green);
    }
    
    .status-qr_pending .status-dot {
      background: #ffaa00;
      box-shadow: 0 0 10px #ffaa00;
      animation: pulse 1.5s infinite;
    }
    
    .status-starting .status-dot {
      background: #00d2d3;
      box-shadow: 0 0 10px #00d2d3;
      animation: pulse 1.5s infinite;
    }
    
    .btn {
      width: 100%;
      padding: 14px 28px;
      font-size: 16px;
      font-weight: 600;
      font-family: inherit;
      border: none;
      border-radius: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    
    .btn-primary {
      background: var(--brand-green);
      color: #0b0f19;
    }
    
    .btn-primary:hover:not(:disabled) {
      background: var(--brand-green-hover);
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(37, 211, 102, 0.3);
    }
    
    .btn-danger {
      background: rgba(255, 71, 87, 0.1);
      color: var(--danger-red);
      border: 1px solid rgba(255, 71, 87, 0.2);
    }
    
    .btn-danger:hover:not(:disabled) {
      background: var(--danger-red);
      color: white;
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(255, 71, 87, 0.3);
    }
    
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .instructions {
      text-align: left;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 16px;
      padding: 20px;
      margin-top: 30px;
      border: 1px solid rgba(255, 255, 255, 0.03);
    }
    
    .instructions h3 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 10px;
      color: var(--text-primary);
    }
    
    .instructions ol {
      list-style-position: inside;
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.6;
    }
    
    .instructions li {
      margin-bottom: 6px;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
    
    @keyframes pulse {
      0% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.2); opacity: 0.5; }
      100% { transform: scale(1); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>WhatsApp Control</h1>
    <p class="subtitle">WholesaleLedger Agent Gateway</p>
    
    <div id="badge-wrapper">
      <div class="status-badge" id="status-badge">
        <span class="status-dot"></span>
        <span id="status-text">Checking Status...</span>
      </div>
    </div>
    
    <div class="qr-container" id="qr-container">
      <div id="qr-slot">
        <p style="color: var(--text-secondary); font-size: 14px;">Initializing connection...</p>
      </div>
    </div>
    
    <div id="action-wrapper">
      <button class="btn btn-primary" id="action-btn" disabled>
        Please Wait
      </button>
    </div>
    
    <div class="instructions">
      <h3>Connection Steps</h3>
      <ol>
        <li>Click "Start WhatsApp" above to spawn a WhatsApp client.</li>
        <li>Once the QR code displays, open WhatsApp on your phone.</li>
        <li>Tap <strong>Settings</strong> &gt; <strong>Linked Devices</strong> &gt; <strong>Link a Device</strong>.</li>
        <li>Scan the QR code to connect. Session will persist.</li>
      </ol>
    </div>
  </div>

  <script>
    const qrContainer = document.getElementById("qr-container");
    const qrSlot = document.getElementById("qr-slot");
    const statusBadge = document.getElementById("status-badge");
    const statusText = document.getElementById("status-text");
    const actionBtn = document.getElementById("action-btn");
    
    let currentStatus = null;
    let isRequesting = false;
    
    async function updateStatus() {
      if (isRequesting) return;
      const response = await fetch("/api/qr").catch(() => null);
      if (!response) return;
      const data = await response.json();
      
      const status = data.status; // disconnected, connected, qr_pending
      
      if (status !== currentStatus) {
        currentStatus = status;
        
        // Update badge class
        statusBadge.className = "status-badge status-" + status;
        statusText.textContent = status === "qr_pending" ? "Waiting for Scan" : status;
        
        // Update controls based on status
        if (status === "connected") {
          qrContainer.classList.remove("active-qr");
          qrSlot.innerHTML = '<div style="color: var(--brand-green); font-weight: 600; font-size: 16px;">✓ WhatsApp Connected</div>';
          actionBtn.className = "btn btn-danger";
          actionBtn.textContent = "Disconnect WhatsApp";
          actionBtn.disabled = false;
          actionBtn.onclick = handleStop;
        } else if (status === "qr_pending" && data.qr) {
          qrContainer.classList.add("active-qr");
          qrSlot.innerHTML = '<img class="qr-image" src="' + data.qr + '" alt="WhatsApp QR">';
          actionBtn.className = "btn btn-danger";
          actionBtn.textContent = "Cancel Connection";
          actionBtn.disabled = false;
          actionBtn.onclick = handleStop;
        } else {
          // Disconnected
          qrContainer.classList.remove("active-qr");
          qrSlot.innerHTML = '<p style="color: var(--text-secondary); font-size: 14px;">WhatsApp is offline</p>';
          actionBtn.className = "btn btn-primary";
          actionBtn.textContent = "Start WhatsApp Client";
          actionBtn.disabled = false;
          actionBtn.onclick = handleStart;
        }
      } else if (status === "qr_pending" && data.qr) {
        // Refresh QR image if it has changed
        const existingImg = qrSlot.querySelector("img");
        if (existingImg && existingImg.src !== data.qr) {
          existingImg.src = data.qr;
        } else if (!existingImg) {
          qrSlot.innerHTML = '<img class="qr-image" src="' + data.qr + '" alt="WhatsApp QR">';
        }
      }
    }
    
    async function handleStart() {
      actionBtn.disabled = true;
      actionBtn.textContent = "Starting Client...";
      statusText.textContent = "Starting...";
      statusBadge.className = "status-badge status-starting";
      
      isRequesting = true;
      const response = await fetch("/api/whatsapp/start", { method: "POST" }).catch(() => null);
      isRequesting = false;
      
      if (response && response.ok) {
        currentStatus = null; // force update
        updateStatus();
      } else {
        alert("Failed to start WhatsApp client.");
        actionBtn.disabled = false;
        actionBtn.textContent = "Start WhatsApp Client";
      }
    }
    
    async function handleStop() {
      if (!confirm("Are you sure you want to stop/disconnect the WhatsApp client?")) return;
      actionBtn.disabled = true;
      actionBtn.textContent = "Stopping Client...";
      statusText.textContent = "Stopping...";
      statusBadge.className = "status-badge status-starting";
      
      isRequesting = true;
      const response = await fetch("/api/whatsapp/stop", { method: "POST" }).catch(() => null);
      isRequesting = false;
      
      if (response && response.ok) {
        currentStatus = null; // force update
        updateStatus();
      } else {
        alert("Failed to stop WhatsApp client.");
        actionBtn.disabled = false;
      }
    }
    
    updateStatus();
    setInterval(updateStatus, 2000);
  </script>
</body>
</html>`);
  });

  router.post("/whatsapp/start", async (req, res, next) => {
    try {
      const status = getWhatsAppStatus();
      if (status.connected || status.qr_pending) {
        return res.json({ ok: true, status: whatsappStatusLabel(), message: "Already running" });
      }
      logger.info("Manual WhatsApp start requested via API");
      // Asynchronous non-blocking call
      startWhatsAppClient().catch((error) => {
        logger.error("Failed to start WhatsApp client from API", { error: error.message });
      });
      res.json({ ok: true, status: "starting" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/whatsapp/stop", async (req, res, next) => {
    try {
      logger.info("Manual WhatsApp stop requested via API");
      await stopWhatsAppClient();
      res.json({ ok: true, status: "disconnected" });
    } catch (error) {
      next(error);
    }
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
