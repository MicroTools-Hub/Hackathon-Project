import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { config } from "./config.js";
import { createApiRouter, paymentToEvent } from "./routes/api.js";
import { startWhatsAppClient } from "./whatsapp/client.js";
import { store } from "./store/memory.js";
import { sseManager } from "./sse/manager.js";
import { logger } from "./utils/logger.js";
import { scheduleDailyReminders } from "./jobs/reminders.js";
import { hasSavedSession } from "./utils/waSession.js";

await fs.mkdir(config.sessionDir, { recursive: true });
await fs.mkdir(config.uploadsDir, { recursive: true });

const app = express();
const corsOrigin = config.frontendOrigin === "*"
  ? true
  : config.frontendOrigins.length ? config.frontendOrigins : config.frontendOrigin;

app.use(cors({
  origin: corsOrigin,
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

sseManager.setSnapshotProvider(() => ({
  clients: store.listClients(),
  payments: store.listPayments({ limit: 50 }),
  transactions: store.listTransactions({ limit: 75 }),
  stats: store.getStats(),
  business: store.getBusiness()
}));

const apiRouter = createApiRouter();
app.use("/", apiRouter);
app.use("/api", apiRouter);

scheduleDailyReminders();

const server = app.listen(config.port, config.host, async () => {
  logger.info(`WholesaleLedger backend running on port ${config.port}`);
  logger.info(`SSE endpoint: http://localhost:${config.port}/sse`);

  if (config.demoMode) {
    logger.info("DEMO_MODE=true; WhatsApp startup skipped and fake SSE payments enabled");
    startDemoPaymentTimer();
  } else if (config.startWhatsApp) {
    try {
      logger.info("Scan QR code in WhatsApp > Linked devices when it appears.");
      await startWhatsAppClient();
    } catch (error) {
      logger.error("Failed to start WhatsApp client", { error: error.message });
    }
  } else {
    logger.info("WhatsApp startup skipped because START_WHATSAPP=false. Checking for saved session...");
    hasSavedSession(config.sessionDir).then((hasSession) => {
      if (hasSession) {
        logger.info("Saved WhatsApp session found. Auto-starting WhatsApp client...");
        startWhatsAppClient().catch((error) => {
          logger.error("Failed to auto-start WhatsApp client from saved session", { error: error.message });
        });
      } else {
        logger.info("No saved WhatsApp session found. WhatsApp will remain stopped until manually started.");
      }
    }).catch((err) => {
      logger.error("Error checking for saved WhatsApp session on startup", { error: err.message });
    });
  }
});

function shutdown(signal) {
  logger.info(`Received ${signal}; shutting down`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Prevent any single uncaught error from taking down the entire server
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception (server kept alive)", { error: error.message, stack: error.stack });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection (server kept alive)", { reason: String(reason) });
});

function startDemoPaymentTimer() {
  const timer = setInterval(() => {
    const payment = createDemoPayment();
    sseManager.payment(paymentToEvent(payment));
  }, 30000);
  timer.unref();
}

function createDemoPayment() {
  const clients = store.listClients();
  const client = clients[Math.floor(Math.random() * clients.length)] || null;
  const confidence = Math.random() > 0.2 ? 0.9 + Math.random() * 0.08 : 0.65 + Math.random() * 0.14;
  return store.addPayment({
    client_id: confidence >= 0.85 ? client?.id : null,
    client_name: client?.name || "Demo Client",
    amount: randomFrom([3000, 4500, 6000, 8000, 12000, 15000, 25000]),
    mode: randomFrom(["upi", "cash", "neft", "rtgs"]),
    recorded_at: Date.now(),
    source: randomFrom(["whatsapp_text", "whatsapp_voice", "whatsapp_image"]),
    source_number: randomFrom(store.listTrustedNumbers()) || "+919876500001",
    raw_input: "Demo mode auto payment event",
    confidence,
    status: confidence >= 0.85 && client ? "confirmed" : "pending_review",
    utr_number: Math.random() > 0.55 ? `UPI${Math.floor(100000 + Math.random() * 899999)}` : null,
    match_score: confidence >= 0.85 ? 1 : 0.7
  });
}

function randomFrom(values) {
  return values[Math.floor(Math.random() * values.length)];
}
