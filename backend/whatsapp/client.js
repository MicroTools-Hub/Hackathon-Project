import fs from "node:fs/promises";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  isLidUser
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { sseManager } from "../sse/manager.js";
import { store } from "../store/memory.js";
import { handleIncomingMessages } from "./handler.js";

let socket = null;
let saveCredsHandler = null;
let reconnectAttempts = 0;
let latestQrDataUrl = null;
let reconnectTimer = null;
const MAX_RECONNECTS = 5;

/* ── LID-to-phone mapping ───────────────────────────────────── */
const lidToPhone = new Map();   // "84301618135205" → "919637732365"

/**
 * Load LID↔phone mappings from Baileys' lid-mapping-*.json files.
 * Files named  lid-mapping-<phone>.json  contain the LID digits.
 * Files named  lid-mapping-<lid>_reverse.json  contain the phone digits.
 */
async function loadLidMappingsFromDisk() {
  try {
    const entries = await fs.readdir(config.sessionDir);
    let count = 0;
    for (const entry of entries) {
      if (!entry.startsWith("lid-mapping-") || !entry.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(config.sessionDir, entry), "utf8").catch(() => null);
      if (!raw) continue;
      const value = JSON.parse(raw);   // a quoted string like "84301618135205"
      const baseName = entry.replace("lid-mapping-", "").replace(".json", "");

      if (baseName.endsWith("_reverse")) {
        // lid-mapping-<lidDigits>_reverse.json  → value is phone digits
        const lidDigits = baseName.replace("_reverse", "");
        if (value) { lidToPhone.set(lidDigits, String(value)); count++; }
      } else {
        // lid-mapping-<phoneDigits>.json  → value is LID digits
        const phoneDigits = baseName;
        if (value) { lidToPhone.set(String(value), phoneDigits); count++; }
      }
    }
    if (count) logger.info(`Loaded ${count} LID mappings from disk, map size: ${lidToPhone.size}`);
  } catch (err) {
    logger.warn("Could not load LID mappings from disk", { error: err.message });
  }
}

function indexContact(contact) {
  if (!contact) return;
  const phoneJid = contact.id && !isLidUser(contact.id) ? contact.id : null;
  const lidJid   = contact.lid || (contact.id && isLidUser(contact.id) ? contact.id : null);
  if (phoneJid && lidJid) {
    const phoneDigits = phoneJid.split("@")[0].split(":")[0];
    const lidDigits   = lidJid.split("@")[0].split(":")[0];
    lidToPhone.set(lidDigits, phoneDigits);
  }
}

export function resolveLidToPhone(lidJidOrDigits) {
  const digits = String(lidJidOrDigits || "").split("@")[0].split(":")[0];
  return lidToPhone.get(digits) || null;
}

export function getLidMapSize() { return lidToPhone.size; }

globalThis.wholesaleLedgerWhatsAppStatus ||= { connected: false, qr_pending: false };

export function getWhatsAppSocket() {
  return socket;
}

export function getWhatsAppStatus() {
  return globalThis.wholesaleLedgerWhatsAppStatus || { connected: false, qr_pending: false };
}

export function getLatestQrDataUrl() {
  return latestQrDataUrl;
}

export async function startWhatsAppClient() {
  await fs.mkdir(config.sessionDir, { recursive: true });
  await loadLidMappingsFromDisk();
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  saveCredsHandler = saveCreds;
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["WholesaleLedger", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  socket.ev.on("creds.update", saveCredsHandler);
  socket.ev.on("connection.update", handleConnectionUpdate);
  socket.ev.on("messages.upsert", async (event) => {
    await handleIncomingMessages(socket, event);
  });

  /* ── Contact sync: build LID ↔ phone mapping ─── */
  socket.ev.on("contacts.upsert", (contacts) => {
    let mapped = 0;
    for (const c of contacts) { indexContact(c); mapped++; }
    if (mapped) logger.info(`Indexed ${mapped} contacts, LID map size: ${lidToPhone.size}`);
  });
  socket.ev.on("contacts.update", (updates) => {
    for (const c of updates) indexContact(c);
  });
  socket.ev.on("messaging-history.set", ({ contacts }) => {
    if (contacts) {
      for (const c of contacts) indexContact(c);
      logger.info(`History sync contacts indexed, LID map size: ${lidToPhone.size}`);
    }
  });

  return socket;
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    globalThis.wholesaleLedgerWhatsAppStatus = { connected: false, qr_pending: true };
    latestQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 }).catch(() => null);
    logger.info("WhatsApp QR received. Scan this QR in WhatsApp > Linked devices.");
    qrcode.generate(qr, { small: true });
    store.addConnectionEvent("qr", "WhatsApp QR generated");
    sseManager.connection({ status: "qr", message: "WhatsApp QR generated" });
    sseManager.whatsappStatus("qr_pending");
  }

  if (connection === "open") {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    globalThis.wholesaleLedgerWhatsAppStatus = { connected: true, qr_pending: false };
    latestQrDataUrl = null;
    logger.info("WhatsApp connected");
    store.addConnectionEvent("connected", "WhatsApp connected");
    sseManager.whatsappStatus("connected");
  }

  if (connection === "close") {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    globalThis.wholesaleLedgerWhatsAppStatus = { connected: false, qr_pending: false, statusCode };
    logger.warn("WhatsApp connection closed", { statusCode, loggedOut });
    store.addConnectionEvent("closed", "WhatsApp connection closed", { statusCode });
    sseManager.connection({ status: "closed", message: "WhatsApp connection closed", statusCode });
    sseManager.whatsappStatus("disconnected");

    if (!loggedOut && reconnectAttempts < MAX_RECONNECTS) {
      reconnectAttempts += 1;
      logger.info("Reconnecting WhatsApp", { attempt: reconnectAttempts, max: MAX_RECONNECTS });
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (getWhatsAppStatus().connected) {
          logger.info("Skipping WhatsApp reconnect because socket is already connected");
          return;
        }
        startWhatsAppClient().catch((error) => logger.error("WhatsApp reconnect failed", { error: error.message }));
      }, 5000);
    } else if (loggedOut) {
      logger.warn("WhatsApp logged out. Clearing session files and restarting WhatsApp client to generate new QR...");
      (async () => {
        try {
          await stopWhatsAppClient();
          await fs.rm(config.sessionDir, { recursive: true, force: true });
          logger.info("Session directory cleared. Initiating fresh connection in 2 seconds...");
          setTimeout(() => {
            startWhatsAppClient().catch((error) => logger.error("WhatsApp restart failed after logout:", { error: error.message }));
          }, 2000);
        } catch (err) {
          logger.error("Failed to clear session files on logout:", { error: err.message });
        }
      })();
    }
  }
}

export async function stopWhatsAppClient() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!socket) return;
  socket.ev.off("creds.update", saveCredsHandler);
  socket.end?.();
  socket = null;
}
