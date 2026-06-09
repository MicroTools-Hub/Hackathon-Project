import fs from "node:fs/promises";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isLidUser,
  USyncQuery,
  USyncUser
} from "@whiskeysockets/baileys";
import { useAuthState, clearSavedSession } from "../utils/waSession.js";
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

export async function fetchLidsForPhones(sock, phoneJids) {
  if (!sock) return [];
  try {
    const usyncQuery = new USyncQuery().withLIDProtocol().withContext('background');
    let added = 0;
    for (const jid of phoneJids) {
      if (isLidUser(jid)) {
        continue;
      }
      usyncQuery.withUser(new USyncUser().withId(jid));
      added++;
    }
    if (added === 0) return [];
    
    const results = await sock.executeUSyncQuery(usyncQuery);
    if (results && results.list) {
      const mappings = results.list
        .filter(a => !!a.lid)
        .map(({ lid, id }) => ({ pn: id, lid: lid }));
      return mappings;
    }
  } catch (err) {
    logger.warn("Failed to fetch LIDs from USync query", { error: err.message });
  }
  return [];
}

export async function syncLidsForTrustedNumbers(sock) {
  if (!sock) {
    logger.warn("Cannot sync LIDs: socket is not initialized");
    return;
  }
  const trustedNumbers = store.listTrustedNumbers();
  const ownerNumber = store.getBusiness()?.owner_number;
  const numbersToSync = [...new Set([ownerNumber, ...trustedNumbers].filter(Boolean))];
  
  logger.info("Syncing LIDs for trusted numbers", { numbersToSync });
  
  // 1. Primary Sync: query LIDs directly via USync
  try {
    const jidsToSync = numbersToSync.map(phone => {
      const digits = phone.replace(/\D/g, "");
      return `${digits}@s.whatsapp.net`;
    });
    const mappings = await fetchLidsForPhones(sock, jidsToSync);
    logger.info("USync LID query mappings resolved", { mappings });
    for (const mapping of mappings) {
      if (mapping.pn && mapping.lid) {
        const phoneDigits = mapping.pn.split("@")[0].split(":")[0];
        const lidDigits = mapping.lid.split("@")[0].split(":")[0];
        lidToPhone.set(lidDigits, phoneDigits);
        logger.info("Mapped trusted number LID via USync", { phone: phoneDigits, lid: lidDigits });
      }
    }
  } catch (err) {
    logger.warn("Failed to sync LIDs using USync", { error: err.message });
  }

  // 2. Fallback Sync: use onWhatsApp (as fallback only)
  for (const phone of numbersToSync) {
    try {
      const digits = phone.replace(/\D/g, "");
      const results = await sock.onWhatsApp(digits);
      if (results && results.length > 0) {
        const result = results[0];
        logger.info("onWhatsApp fallback result details", { phone, result: JSON.stringify(result) });
        if (result.exists && result.lid) {
          const lidDigits = result.lid.split("@")[0].split(":")[0];
          const phoneDigits = result.jid.split("@")[0].split(":")[0];
          if (!lidToPhone.has(lidDigits)) {
            lidToPhone.set(lidDigits, phoneDigits);
            logger.info("Mapped trusted number LID via onWhatsApp fallback", { phone: phoneDigits, lid: lidDigits });
          }
        }
      }
    } catch (err) {
      logger.warn("Failed to sync LID for trusted number via onWhatsApp fallback", { phone, error: err.message });
    }
  }
}

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
  if (socket) {
    logger.info("WhatsApp client is already running, skipping start");
    return socket;
  }
  await fs.mkdir(config.sessionDir, { recursive: true });
  await loadLidMappingsFromDisk();
  const { state, saveCreds } = await useAuthState(config.sessionDir);
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

    // Sync LIDs for trusted numbers on connection open
    syncLidsForTrustedNumbers(socket).catch((err) => {
      logger.error("Failed to sync LIDs for trusted numbers on connection open", { error: err.message });
    });
  }

  if (connection === "close") {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    const wasQrPending = globalThis.wholesaleLedgerWhatsAppStatus?.qr_pending === true;
    
    socket = null; // Clean up old closed socket reference to allow new connections
    globalThis.wholesaleLedgerWhatsAppStatus = { connected: false, qr_pending: false, statusCode };
    logger.warn("WhatsApp connection closed", { statusCode, loggedOut });
    store.addConnectionEvent("closed", "WhatsApp connection closed", { statusCode });
    sseManager.connection({ status: "closed", message: "WhatsApp connection closed", statusCode });
    sseManager.whatsappStatus("disconnected");
 
    const isBadSession = loggedOut || statusCode === 401;

    if (!isBadSession) {
      // Always increment reconnect attempts (including QR timeouts) to prevent
      // an infinite reconnect loop that causes memory exhaustion and OOM crash.
      reconnectAttempts += 1;
      const isQrTimeout = wasQrPending || statusCode === 408 || statusCode === 503;
      if (reconnectAttempts <= MAX_RECONNECTS) {
        logger.info("Reconnecting WhatsApp", { attempt: reconnectAttempts, max: MAX_RECONNECTS, isQrTimeout });
        if (reconnectTimer) clearTimeout(reconnectTimer);
        // Back off longer for QR timeouts to avoid hammering WhatsApp servers
        const delay = isQrTimeout ? 15_000 : 5_000;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (getWhatsAppStatus().connected) {
            logger.info("Skipping WhatsApp reconnect because socket is already connected");
            return;
          }
          // Reset counter so next manual reconnect gets full retries
          reconnectAttempts = 0;
          startWhatsAppClient().catch((error) => logger.error("WhatsApp reconnect failed", { error: error.message }));
        }, delay);
      } else {
        logger.warn("Max WhatsApp reconnect attempts reached — giving up. Restart the server or re-scan QR.", { attempts: reconnectAttempts });
      }
    } else {
      logger.warn("WhatsApp session is invalid or logged out. Clearing session files/Supabase and restarting client...", { statusCode, loggedOut });
      (async () => {
        try {
          await stopWhatsAppClient();
          await clearSavedSession(config.sessionDir);
          logger.info("WhatsApp session cleared completely. Initiating fresh connection in 2 seconds...");
          setTimeout(() => {
            startWhatsAppClient().catch((error) => logger.error("WhatsApp restart failed after session clear:", { error: error.message }));
          }, 2000);
        } catch (err) {
          logger.error("Failed to clear session on bad session/logout:", { error: err.message });
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
  if (socket) {
    try {
      socket.ev.off("creds.update", saveCredsHandler);
      socket.end?.();
    } catch (err) {
      logger.warn("Error ending WhatsApp socket connection", { error: err.message });
    }
    socket = null;
  }
  globalThis.wholesaleLedgerWhatsAppStatus = { connected: false, qr_pending: false };
  latestQrDataUrl = null;
}
