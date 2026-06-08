import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { formatINR, normalizePhone } from "../utils/format.js";
import { bestClientMatch } from "../utils/fuzzy.js";
import { ensureRating, recalculateRating } from "../utils/rating.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.resolve(config.sessionDir, "db.json");


const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const at = (days, hour = 12, minute = 0) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  date.setDate(date.getDate() + days);
  return date.getTime();
};

let business;
let clients = [];
let transactions = [];
const connectionEvents = [];
let creditLimitAlerts = [];

async function saveDb() {
  try {
    await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
    const data = {
      business,
      clients,
      transactions,
      creditLimitAlerts
    };
    await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save database to db.json", error);
  }
}

function makeClient(name, phone, creditLimit, cycleDays, id = null) {
  const client = {
    id: id || randomUUID(),
    business_id: business.id,
    name,
    phone: normalizePhone(phone),
    credit_limit: creditLimit,
    payment_cycle_days: cycleDays,
    running_balance: 0,
    last_goods_date: null,
    last_payment_date: null,
    last_payment_amount: 0,
    due_date: null,
    rating: "good",
    rating_score: 70,
    payment_before_due_streak: 0,
    last_reminder_at: null,
    created_at: now
  };
  ensureRating(client);
  return client;
}

function seedTransactions() {
  const rows = [];
  const clientByName = Object.fromEntries(clients.map((client) => [client.name, client]));
  const goods = (clientName, amount, days, description) => rows.push(createTransaction({
    client_id: clientByName[clientName]?.id,
    client_name: clientName,
    type: "goods",
    amount,
    description,
    recorded_at: at(days, 10, 30),
    source: "manual",
    source_number: business.owner_number || business.trusted_numbers[0],
    raw_input: `Seed goods: ${description}`,
    confidence: 1,
    status: "confirmed"
  }));
  const payment = (clientName, amount, days, mode, source, raw_input, confidence, status, number, utr = null) => rows.push(createTransaction({
    client_id: clientByName[clientName]?.id,
    client_name: clientName,
    type: "payment",
    amount,
    mode,
    recorded_at: at(days, 11 + Math.floor(Math.random() * 5), Math.floor(Math.random() * 50)),
    source,
    source_number: normalizePhone(number),
    raw_input,
    confidence,
    status,
    utr_number: utr
  }));

  goods("Sharma General Store", 80000, -10, "monthly grocery stock");
  payment("Sharma General Store", 10000, -4, "upi", "whatsapp_voice", "Sharma ne das hazaar UPI bheja RAM ke liye", 0.94, "confirmed", "+919876500001", "UPI632118");
  payment("Sharma General Store", 7500, -1, "cash", "whatsapp_text", "Received cash 7500 from Sharma General", 0.91, "confirmed", "+919876500002");
  payment("Sharma General Store", 22000, -25, "upi", "whatsapp_image", "Screenshot Sharma old invoice paid 22000", 0.95, "confirmed", "+919876500001", "UPI771020");

  goods("Kiran Textiles", 98000, -35, "fabric bales");
  payment("Kiran Textiles", 18000, -28, "cheque", "manual", "Cheque collected against old Kiran balance", 1, "confirmed", "+919876500001");
  payment("Kiran Textiles", 12000, -1, "upi", "whatsapp_text", "Kiran wale bol rahe barah hazaar bheja hai, invoice unsure", 0.73, "pending_review", "+919876500002", "UPI992081");

  goods("Patel Merchants", 140000, -20, "assorted wholesale goods");
  payment("Patel Merchants", 25000, -12, "rtgs", "whatsapp_text", "Patel Merchants cleared previous bill by RTGS 25000", 0.93, "confirmed", "+919876500002", "RTGS2011");
  payment("Patel Merchants", 8000, 0, "unknown", "whatsapp_voice", "Patel ka kuch eight thousand received maybe cash", 0.68, "pending_review", "+919876500001");

  goods("National Electricals", 87000, -8, "electrical supplies");
  payment("National Electricals", 50000, -6, "upi", "whatsapp_image", "UPI screenshot National Electricals 50000 credited", 0.96, "confirmed", "+919876500001", "UTR887650");
  payment("National Electricals", 37000, -2, "neft", "manual", "Manual entry after bank reconciliation", 1, "confirmed", "+919876500001");

  goods("Ravi Bros Hardware", 62000, -45, "hardware stock");
  payment("Ravi Bros Hardware", 15000, -31, "cash", "whatsapp_voice", "Ravi Bros se purana pandrah hazaar cash mila", 0.9, "confirmed", "+919876500002");

  return rows.sort((a, b) => b.recorded_at - a.recorded_at);
}

async function loadDb() {
  try {
    await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
    const content = await fs.readFile(DB_FILE, "utf8");
    const data = JSON.parse(content);
    business = data.business;
    if (business && !business.trusted_number_meta) {
      business.trusted_number_meta = (business.trusted_numbers || []).map((num) => ({
        phone: num,
        label: num === business.owner_number ? "Owner" : "Staff",
        active: true,
        last_message_at: null,
        created_at: Date.now()
      }));
    }
    clients = data.clients;
    transactions = data.transactions;
    creditLimitAlerts = data.creditLimitAlerts || [];
    rebuildAllLedgers();
  } catch (error) {
    // Database file does not exist, seed database
    business = {
      id: randomUUID(),
      name: config.business.name,
      prefix: config.business.prefix,
      owner_number: normalizePhone(config.ownerNumber),
      trusted_numbers: config.trustedNumbers.map(normalizePhone),
      trusted_number_meta: config.trustedNumbers.map((num) => ({
        phone: normalizePhone(num),
        label: num === config.ownerNumber ? "Owner" : "Staff",
        active: true,
        last_message_at: null,
        created_at: now
      })),
      created_at: now
    };

    if (config.demoMode) {
      clients.push(
        makeClient("Sharma General Store", "+919890001111", 100000, 7),
        makeClient("Kiran Textiles", "+919890002222", 120000, 30),
        makeClient("Patel Merchants", "+919890003333", 180000, 15),
        makeClient("National Electricals", "+919890004444", 150000, 30),
        makeClient("Ravi Bros Hardware", "+919890005555", 90000, 15)
      );
      transactions = seedTransactions();
    } else {
      clients = [];
      transactions = [];
    }

    rebuildAllLedgers();
    await saveDb();
  }
}

await loadDb();

function createTransaction(data) {
  const client = data.client_id ? clients.find((item) => item.id === data.client_id) : null;
  return {
    id: data.id || randomUUID(),
    business_id: business.id,
    client_id: data.client_id || null,
    client_name: data.client_name || client?.name || "",
    type: data.type || "payment",
    amount: Number(data.amount || 0),
    mode: data.mode || (data.type === "payment" ? "unknown" : null),
    utr_number: data.utr_number || null,
    description: data.description || null,
    balance_before: Number(data.balance_before || client?.running_balance || 0),
    balance_after: Number(data.balance_after || client?.running_balance || 0),
    due_date_at_transaction: data.due_date_at_transaction || client?.due_date || null,
    recorded_at: Number(data.recorded_at || Date.now()),
    source: data.source || "manual",
    source_number: normalizePhone(data.source_number),
    raw_input: data.raw_input || "",
    confidence: Number(data.confidence ?? 1),
    status: data.status || "pending_review",
    review_reason: data.review_reason || null,
    business_prefix: data.business_prefix || business.prefix,
    match_score: Number(data.match_score || 0),
    applied_to_balance: false,
    created_at: data.created_at || Date.now(),
    credit_days: data.credit_days !== undefined ? data.credit_days : null
  };
}

function resetClientLedger(client) {
  client.running_balance = 0;
  client.last_goods_date = null;
  client.last_payment_date = null;
  client.last_payment_amount = 0;
  client.due_date = null;
  client.rating_score = 70;
  client.rating = "good";
  client.payment_before_due_streak = 0;
  ensureRating(client);
}

function rebuildAllLedgers() {
  for (const client of clients) resetClientLedger(client);
  for (const transaction of transactions) {
    transaction.applied_to_balance = false;
    const client = transaction.client_id ? clients.find((item) => item.id === transaction.client_id) : null;
    transaction.balance_before = client?.running_balance || 0;
    transaction.balance_after = client?.running_balance || 0;
    transaction.due_date_at_transaction = client?.due_date || null;
  }

  const ordered = [...transactions].sort((a, b) => a.recorded_at - b.recorded_at || a.created_at - b.created_at);
  for (const transaction of ordered) {
    if (transaction.status !== "confirmed" || !transaction.client_id) continue;
    const client = clients.find((item) => item.id === transaction.client_id);
    if (!client) continue;
    applyConfirmedTransaction(client, transaction);
  }
}

function applyConfirmedTransaction(client, transaction) {
  transaction.balance_before = client.running_balance;

  if (transaction.type === "goods") {
    const previousDueDate = client.due_date;
    const previousGoodsDate = client.last_goods_date;
    const previousCycleFullyUnpaid = Boolean(
      previousDueDate &&
      transaction.recorded_at > previousDueDate &&
      client.running_balance > 0 &&
      (!client.last_payment_date || (previousGoodsDate && client.last_payment_date < previousGoodsDate))
    );
    client.running_balance += transaction.amount;
    client.last_goods_date = transaction.recorded_at;
    const creditDays = Number(transaction.credit_days || client.payment_cycle_days || 30);
    client.due_date = transaction.recorded_at + creditDays * DAY;
    transaction.balance_after = client.running_balance;
    transaction.due_date_at_transaction = client.due_date;
    transaction.applied_to_balance = true;
    transaction.rating_result = recalculateRating(client, {
      type: "goods",
      recorded_at: transaction.recorded_at,
      previous_cycle_fully_unpaid: previousCycleFullyUnpaid
    });
    return;
  }

  if (transaction.type === "payment") {
    const beforeDueDate = client.due_date ? transaction.recorded_at <= client.due_date : false;
    client.running_balance = Math.max(0, client.running_balance - transaction.amount);
    client.last_payment_date = transaction.recorded_at;
    client.last_payment_amount = transaction.amount;
    transaction.balance_after = client.running_balance;
    transaction.due_date_at_transaction = client.due_date;
    transaction.applied_to_balance = true;
    transaction.rating_result = recalculateRating(client, {
      type: "payment",
      recorded_at: transaction.recorded_at,
      before_due_date: beforeDueDate,
      cleared_full_balance: client.running_balance === 0
    });
  }
}

function createCreditLimitAlert(client, amount, data = {}) {
  const projected = client.running_balance + Number(amount || 0);
  if (!client.credit_limit || projected <= client.credit_limit) return null;
  const existingTransaction = data.id ? transactions.find((transaction) => transaction.id === data.id) : null;
  const alert = {
    id: randomUUID(),
    type: "credit_limit",
    status: "pending",
    client_id: client.id,
    client_name: client.name,
    requested_amount: Number(amount || 0),
    current_balance: client.running_balance,
    projected_balance: projected,
    credit_limit: client.credit_limit,
    source_number: data.source_number || "",
    raw_input: data.raw_input || "",
    goods_data: {
      ...data,
      id: existingTransaction?.id || data.id,
      client_id: client.id,
      client_name: client.name,
      type: "goods",
      amount: Number(amount || 0),
      status: "confirmed",
      override_credit_limit: true
    },
    created_at: Date.now(),
    message: `Credit limit alert: ${client.name} wants ${formatINR(amount)} goods but balance is ${formatINR(client.running_balance)}; limit is ${formatINR(client.credit_limit)}. Reply ${business.prefix} OVERRIDE ${client.name} to allow anyway.`
  };
  creditLimitAlerts.unshift(alert);
  creditLimitAlerts.splice(25);
  return alert;
}

function findPendingCreditLimitAlert(identifier) {
  const pending = creditLimitAlerts.filter((alert) => alert.status === "pending");
  const value = String(identifier || "").trim();
  if (!value) return pending[0] || null;

  const exact = pending.find((alert) =>
    alert.id === value ||
    alert.client_id === value ||
    alert.client_name.toLowerCase() === value.toLowerCase()
  );
  if (exact) return exact;

  const match = bestClientMatch(value, clients);
  if (match.score > 0.55) {
    return pending.find((alert) => alert.client_id === match.client.id) || null;
  }

  return pending.find((alert) => alert.client_name.toLowerCase().includes(value.toLowerCase())) || null;
}

export const store = {
  getBusiness() {
    return business;
  },

  updateBusiness(patch) {
    if (!business) {
      business = {
        id: patch.id || randomUUID(),
        name: "",
        prefix: "",
        trusted_numbers: [],
        trusted_number_meta: [],
        created_at: Date.now()
      };
    }
    const oldId = business ? business.id : null;
    if (patch.id) business.id = patch.id;
    if (patch.id && patch.id !== oldId) {
      for (const client of clients) {
        if (!client.business_id || client.business_id === oldId) {
          client.business_id = patch.id;
        }
      }
      for (const trans of transactions) {
        if (!trans.business_id || trans.business_id === oldId) {
          trans.business_id = patch.id;
        }
      }
    }
    if (patch.name) business.name = String(patch.name).trim();
    if (patch.prefix) business.prefix = String(patch.prefix).trim().toUpperCase();
    if (patch.owner_number) business.owner_number = normalizePhone(patch.owner_number);
    if (patch.trusted_numbers) {
      business.trusted_numbers = patch.trusted_numbers.map(normalizePhone).filter(Boolean);
    }
    if (patch.trusted_number_meta) {
      business.trusted_number_meta = patch.trusted_number_meta;
    }
    saveDb();
    return business;
  },

  getClients(businessId = business.id) {
    return clients.filter((client) => client.business_id === businessId);
  },

  listClients() {
    return this.getClients();
  },

  getClient(id) {
    return clients.find((client) => client.id === id) || null;
  },

  addClient(data) {
    const client = makeClient(
      String(data.name || "").trim(),
      normalizePhone(data.phone),
      Number(data.credit_limit || 0),
      Number(data.payment_cycle_days || 30),
      data.id
    );
    if (data.running_balance) client.running_balance = Number(data.running_balance || 0);
    clients.push(client);
    rebuildAllLedgers();
    saveDb();
    return client;
  },

  updateClient(id, patch) {
    const client = clients.find((c) => c.id === id);
    if (!client) return null;
    if (patch.phone !== undefined) client.phone = normalizePhone(patch.phone);
    if (patch.name !== undefined) client.name = String(patch.name).trim();
    if (patch.credit_limit !== undefined) client.credit_limit = Number(patch.credit_limit);
    if (patch.payment_cycle_days !== undefined) client.payment_cycle_days = Number(patch.payment_cycle_days);
    rebuildAllLedgers();
    saveDb();
    return client;
  },


  matchClient(clientName) {
    return bestClientMatch(clientName, clients);
  },

  listTrustedNumbers() {
    return [...business.trusted_numbers];
  },

  isTrustedNumber(phone) {
    const normalized = normalizePhone(phone);
    if (normalized === business.owner_number) return true; // Owner is always trusted
    if (!business.trusted_number_meta) return business.trusted_numbers.includes(normalized);
    const meta = business.trusted_number_meta.find((item) => item.phone === normalized);
    return !!(meta && meta.active);
  },

  setTrustedNumbers(numbers) {
    const normalizedList = numbers.map(normalizePhone).filter(Boolean);
    business.trusted_numbers = [...new Set(normalizedList)];
    if (!business.trusted_number_meta) {
      business.trusted_number_meta = [];
    }
    // Remove meta for numbers no longer present
    business.trusted_number_meta = business.trusted_number_meta.filter((item) =>
      normalizedList.includes(item.phone)
    );
    // Add meta for new numbers
    normalizedList.forEach((num) => {
      if (!business.trusted_number_meta.some((item) => item.phone === num)) {
        business.trusted_number_meta.push({
          phone: num,
          label: "Staff",
          active: true,
          last_message_at: null,
          created_at: Date.now()
        });
      }
    });
    saveDb();
    return business.trusted_numbers;
  },

  addTrustedNumber(phone, label = "Staff") {
    const normalized = normalizePhone(phone);
    if (normalized) {
      if (!business.trusted_numbers.includes(normalized)) {
        business.trusted_numbers.push(normalized);
      }
      if (!business.trusted_number_meta) {
        business.trusted_number_meta = [];
      }
      if (!business.trusted_number_meta.some((item) => item.phone === normalized)) {
        business.trusted_number_meta.push({
          phone: normalized,
          label: label || "Staff",
          active: true,
          last_message_at: null,
          created_at: Date.now()
        });
      }
      saveDb();
    }
    return business.trusted_numbers;
  },

  removeTrustedNumber(phone) {
    const normalized = normalizePhone(phone);
    business.trusted_numbers = business.trusted_numbers.filter((item) => item !== normalized);
    if (business.trusted_number_meta) {
      business.trusted_number_meta = business.trusted_number_meta.filter((item) => item.phone !== normalized);
    }
    saveDb();
    return business.trusted_numbers;
  },

  touchTrustedNumber(phone) {
    const normalized = normalizePhone(phone);
    if (business.trusted_number_meta) {
      const meta = business.trusted_number_meta.find((item) => item.phone === normalized);
      if (meta) {
        meta.last_message_at = Date.now();
        saveDb();
      }
    }
  },

  toggleTrustedNumber(phone, active) {
    const normalized = normalizePhone(phone);
    if (business.trusted_number_meta) {
      business.trusted_number_meta = business.trusted_number_meta.map((item) =>
        item.phone === normalized ? { ...item, active: !!active } : item
      );
      saveDb();
    }
    return business.trusted_numbers;
  },

  addPayment(data) {
    if (data.id && transactions.some((t) => t.id === data.id)) {
      const existing = transactions.find((t) => t.id === data.id);
      Object.assign(existing, data, { updated_at: Date.now() });
      rebuildAllLedgers();
      saveDb();
      return existing;
    }
    const transaction = createTransaction({ ...data, type: "payment" });
    transactions.unshift(transaction);
    rebuildAllLedgers();
    saveDb();
    return transaction;
  },

  addGoods(data) {
    const client = data.client_id ? this.getClient(data.client_id) : null;
    const status = data.status || "pending_review";
    if (client && status === "confirmed" && !data.override_credit_limit) {
      const alert = createCreditLimitAlert(client, data.amount, data);
      if (alert) {
        saveDb();
        return { blocked: true, alert };
      }
    }

    if (data.id && transactions.some((t) => t.id === data.id)) {
      const existing = transactions.find((t) => t.id === data.id);
      Object.assign(existing, data, { updated_at: Date.now() });
      rebuildAllLedgers();
      saveDb();
      return { blocked: false, transaction: existing };
    }

    const transaction = createTransaction({ ...data, type: "goods" });
    transactions.unshift(transaction);
    rebuildAllLedgers();
    saveDb();
    return { blocked: false, transaction };
  },

  addTransaction(data) {
    if (data.type === "goods") return this.addGoods(data);
    return { blocked: false, transaction: this.addPayment(data) };
  },

  listTransactions(filters = {}) {
    let rows = [...transactions].sort((a, b) => b.recorded_at - a.recorded_at || b.created_at - a.created_at);
    if (filters.type) rows = rows.filter((transaction) => transaction.type === filters.type);
    if (filters.client_id) rows = rows.filter((transaction) => transaction.client_id === filters.client_id);
    if (filters.status) rows = rows.filter((transaction) => transaction.status === filters.status);
    if (filters.business_id) rows = rows.filter((transaction) => transaction.business_id === filters.business_id);
    const limit = Number(filters.limit || 0);
    return limit > 0 ? rows.slice(0, limit) : rows;
  },

  getTransaction(id) {
    return transactions.find((transaction) => transaction.id === id) || null;
  },

  updateTransaction(id, updates) {
    const transaction = this.getTransaction(id);
    if (!transaction) return null;
    Object.assign(transaction, updates, { updated_at: Date.now() });
    rebuildAllLedgers();
    saveDb();
    return transaction;
  },

  confirmTransaction(id, updates = {}) {
    const transaction = this.getTransaction(id);
    if (!transaction) return { transaction: null };
    if (transaction.type === "goods" && transaction.status !== "confirmed" && !updates.override_credit_limit) {
      const client = transaction.client_id ? this.getClient(transaction.client_id) : null;
      if (client) {
        const alert = createCreditLimitAlert(client, updates.amount ?? transaction.amount, { ...transaction, ...updates });
        if (alert) {
          saveDb();
          return { transaction, blocked: true, alert };
        }
      }
    }
    Object.assign(transaction, updates, { status: "confirmed", updated_at: Date.now() });
    rebuildAllLedgers();
    saveDb();
    return { transaction, blocked: false };
  },

  deleteTransaction(id) {
    const index = transactions.findIndex((transaction) => transaction.id === id);
    if (index === -1) return null;
    const [deleted] = transactions.splice(index, 1);
    rebuildAllLedgers();
    saveDb();
    return deleted;
  },

  listCreditLimitAlerts(filters = {}) {
    let rows = [...creditLimitAlerts];
    if (filters.status) rows = rows.filter((alert) => alert.status === filters.status);
    if (filters.client_id) rows = rows.filter((alert) => alert.client_id === filters.client_id);
    const limit = Number(filters.limit || 0);
    return limit > 0 ? rows.slice(0, limit) : rows;
  },

  getCreditLimitAlert(id) {
    return creditLimitAlerts.find((alert) => alert.id === id) || null;
  },

  approveCreditLimitOverride(identifier, approverNumber = "") {
    const alert = findPendingCreditLimitAlert(identifier);
    if (!alert) return { alert: null, transaction: null };
    const existing = alert.goods_data?.id ? this.getTransaction(alert.goods_data.id) : null;
    let transaction;
    if (existing) {
      Object.assign(existing, alert.goods_data, {
        status: "confirmed",
        override_credit_limit: true,
        approved_by: normalizePhone(approverNumber),
        approved_at: Date.now(),
        updated_at: Date.now()
      });
      transaction = existing;
      rebuildAllLedgers();
    } else {
      transaction = createTransaction({
        ...alert.goods_data,
        status: "confirmed",
        override_credit_limit: true,
        source: alert.goods_data?.source || "system",
        source_number: alert.goods_data?.source_number || approverNumber,
        raw_input: alert.goods_data?.raw_input || `Credit limit override for ${alert.client_name}`,
        confidence: alert.goods_data?.confidence ?? 1
      });
      transaction.approved_by = normalizePhone(approverNumber);
      transaction.approved_at = Date.now();
      transactions.unshift(transaction);
      rebuildAllLedgers();
    }

    alert.status = "approved";
    alert.approved_by = normalizePhone(approverNumber);
    alert.approved_at = Date.now();
    alert.transaction_id = transaction.id;
    saveDb();
    return { alert, transaction };
  },

  getPayments(filters = {}) {
    return this.listTransactions({ ...filters, type: "payment" });
  },

  listPayments(filters = {}) {
    return this.getPayments(filters);
  },

  getPayment(id) {
    const transaction = this.getTransaction(id);
    return transaction?.type === "payment" ? transaction : null;
  },

  updatePayment(id, updates) {
    const payment = this.getPayment(id);
    if (!payment) return null;
    return this.updateTransaction(id, updates);
  },

  deletePayment(id) {
    const payment = this.getPayment(id);
    if (!payment) return null;
    return this.deleteTransaction(id);
  },

  getDueClients(options = {}) {
    const current = Number(options.now || Date.now());
    return clients.filter((client) => {
      if (!client.due_date || client.running_balance <= 0) return false;
      if (options.overdueOnly) return client.due_date < current;
      return client.due_date <= current + 7 * DAY;
    });
  },

  markReminderSent(clientId) {
    const client = this.getClient(clientId);
    if (!client) return null;
    client.last_reminder_at = Date.now();
    saveDb();
    return client;
  },

  markOverdueNoPayment(clientId) {
    const client = this.getClient(clientId);
    if (!client) return null;
    const rating = recalculateRating(client, { type: "overdue_no_payment" });
    client.last_overdue_rating_at = Date.now();
    saveDb();
    return { client, rating };
  },

  getStats() {
    const currentMonth = new Date();
    const monthStart = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getTime();
    const current = Date.now();
    return {
      total_outstanding: clients.reduce((sum, client) => sum + client.running_balance, 0),
      overdue: clients
        .filter((client) => client.running_balance > 0 && client.due_date && client.due_date < current)
        .reduce((sum, client) => sum + client.running_balance, 0),
      due_this_week: clients
        .filter((client) => client.running_balance > 0 && client.due_date && client.due_date >= current && client.due_date <= current + 7 * DAY)
        .reduce((sum, client) => sum + client.running_balance, 0),
      collected_month: transactions
        .filter((transaction) => transaction.type === "payment" && transaction.status === "confirmed")
        .filter((transaction) => transaction.recorded_at >= monthStart)
        .reduce((sum, transaction) => sum + transaction.amount, 0),
      clients: clients.length,
      payments: transactions.filter((transaction) => transaction.type === "payment").length,
      goods: transactions.filter((transaction) => transaction.type === "goods").length,
      transactions: transactions.length,
      pending_review: transactions.filter((transaction) => transaction.status === "pending_review").length,
      risky_clients: clients.filter((client) => client.rating === "risky").length
    };
  },

  addConnectionEvent(type, message, extra = {}) {
    const event = { id: randomUUID(), type, message, at: Date.now(), ...extra };
    connectionEvents.unshift(event);
    connectionEvents.splice(20);
    return event;
  },

  listConnectionEvents() {
    return [...connectionEvents];
  },

  resetDb() {
    business = {
      id: "",
      name: "",
      prefix: "",
      trusted_numbers: [],
      trusted_number_meta: [],
      created_at: Date.now()
    };
    clients = [];
    transactions = [];
    creditLimitAlerts = [];
    saveDb();
  }
};
