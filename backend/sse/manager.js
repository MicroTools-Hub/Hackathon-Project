import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

const clients = new Map();
let snapshotProvider = () => ({ clients: [], payments: [] });

function writeNamedEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  writeData(res, payload);
}

function writeData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export const sseManager = {
  setSnapshotProvider(provider) {
    snapshotProvider = provider;
  },

  attach(req, res) {
    const id = randomUUID();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write("retry: 5000\n\n");
    clients.set(id, res);
    writeData(res, { type: "snapshot", data: snapshotProvider() });
    logger.info("SSE client connected", { id, clients: clients.size });

    req.on("close", () => {
      clients.delete(id);
      logger.info("SSE client disconnected", { id, clients: clients.size });
    });
  },

  addClient(res) {
    const id = randomUUID();
    clients.set(id, res);
    return id;
  },

  removeClient(idOrRes) {
    if (clients.has(idOrRes)) {
      clients.delete(idOrRes);
      return;
    }
    for (const [id, res] of clients.entries()) {
      if (res === idOrRes) clients.delete(id);
    }
  },

  broadcast(event, payload) {
    const message = typeof event === "string" ? payload : event;
    for (const [id, res] of clients.entries()) {
      try {
        if (typeof event === "string") writeNamedEvent(res, event, message);
        else writeData(res, message);
      } catch (error) {
        logger.warn("Dropping broken SSE client", { id, error: error.message });
        clients.delete(id);
      }
    }
  },

  payment(data) {
    this.broadcast({ type: "payment", data });
  },

  transaction(data) {
    this.broadcast({ type: "transaction", data });
  },

  creditAlert(data) {
    this.broadcast({ type: "credit_limit_alert", data });
  },

  ratingAlert(data) {
    this.broadcast({ type: "rating_alert", data });
  },

  reminder(data) {
    this.broadcast({ type: "reminder", data });
  },

  error(data) {
    this.broadcast({ type: "error", data });
  },

  connection(data) {
    this.broadcast({ type: "connection", data });
  },

  whatsappStatus(status) {
    this.broadcast({ type: "whatsapp_status", data: { status } });
  },

  count() {
    return clients.size;
  },

  clientCount() {
    return clients.size;
  }
};

setInterval(() => {
  for (const [id, res] of clients.entries()) {
    try {
      res.write(": ping\n\n");
    } catch (error) {
      logger.warn("Dropping broken SSE client during ping", { id, error: error.message });
      clients.delete(id);
    }
  }
}, 30000).unref();
