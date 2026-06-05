(function () {
  const DB_NAME = "WholesaleLedgerDB";
  const DB_VERSION = 1;
  const DAY = 24 * 60 * 60 * 1000;
  const STORES = ["businesses", "clients", "invoices", "payments", "settings", "sync_queue"];
  let dbPromise;
  let seedPromise;

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const value = Math.random() * 16 | 0;
      const resolved = char === "x" ? value : (value & 0x3) | 0x8;
      return resolved.toString(16);
    });
  }

  function openDatabase() {
    if (!dbPromise) {
      dbPromise = idb.openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains("businesses")) {
            const store = db.createObjectStore("businesses", { keyPath: "id" });
            store.createIndex("prefix", "prefix");
          }
          if (!db.objectStoreNames.contains("clients")) {
            const store = db.createObjectStore("clients", { keyPath: "id" });
            store.createIndex("business_id", "business_id");
            store.createIndex("name", "name");
          }
          if (!db.objectStoreNames.contains("invoices")) {
            const store = db.createObjectStore("invoices", { keyPath: "id" });
            store.createIndex("business_id", "business_id");
            store.createIndex("client_id", "client_id");
            store.createIndex("status", "status");
            store.createIndex("due_date", "due_date");
          }
          if (!db.objectStoreNames.contains("payments")) {
            const store = db.createObjectStore("payments", { keyPath: "id" });
            store.createIndex("business_id", "business_id");
            store.createIndex("client_id", "client_id");
            store.createIndex("invoice_id", "invoice_id");
            store.createIndex("status", "status");
            store.createIndex("recorded_at", "recorded_at");
            store.createIndex("source_number", "source_number");
          }
          if (!db.objectStoreNames.contains("settings")) {
            db.createObjectStore("settings", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("sync_queue")) {
            const store = db.createObjectStore("sync_queue", { keyPath: "id" });
            store.createIndex("created_at", "created_at");
            store.createIndex("status", "status");
          }
        }
      });
    }
    return dbPromise;
  }

  async function init() {
    const db = await openDatabase();
    if (!seedPromise) seedPromise = seedIfNeeded();
    await seedPromise;
    return db;
  }

  async function seedIfNeeded() {
    const db = await openDatabase();
    const count = await db.count("businesses");
    if (count > 0) return;

    const now = Date.now();
    const at = (days, hour = 10, minute = 0) => {
      const date = new Date();
      date.setHours(hour, minute, 0, 0);
      date.setDate(date.getDate() + days);
      return date.getTime();
    };

    const business = {
      id: uuid(),
      name: "Ramesh Traders",
      prefix: "RAM",
      trusted_numbers: ["+919876500001", "+919876500002"],
      trusted_number_meta: [
        {
          phone: "+919876500001",
          label: "Owner",
          active: true,
          last_message_at: at(-1, 11, 32),
          created_at: now
        },
        {
          phone: "+919876500002",
          label: "Manager",
          active: true,
          last_message_at: at(-3, 17, 5),
          created_at: now
        }
      ],
      created_at: now
    };

    const clients = [
      {
        id: uuid(),
        business_id: business.id,
        name: "Sharma General Store",
        phone: "+919890001111",
        credit_limit: 100000,
        payment_cycle_days: 7,
        created_at: at(-90)
      },
      {
        id: uuid(),
        business_id: business.id,
        name: "Kiran Textiles",
        phone: "+919890002222",
        credit_limit: 120000,
        payment_cycle_days: 30,
        created_at: at(-120)
      },
      {
        id: uuid(),
        business_id: business.id,
        name: "Patel Merchants",
        phone: "+919890003333",
        credit_limit: 180000,
        payment_cycle_days: 15,
        created_at: at(-75)
      },
      {
        id: uuid(),
        business_id: business.id,
        name: "National Electricals",
        phone: "+919890004444",
        credit_limit: 150000,
        payment_cycle_days: 30,
        created_at: at(-180)
      },
      {
        id: uuid(),
        business_id: business.id,
        name: "Ravi Bros Hardware",
        phone: "+919890005555",
        credit_limit: 90000,
        payment_cycle_days: 15,
        created_at: at(-140)
      }
    ];

    const byName = Object.fromEntries(clients.map((client) => [client.name, client]));
    const invoice = (clientName, amount, dueDays, createdDays, notes, status = "active") => ({
      id: uuid(),
      business_id: business.id,
      client_id: byName[clientName].id,
      amount,
      due_date: at(dueDays, 18, 0),
      created_at: at(createdDays, 9, 30),
      notes,
      status
    });

    const invoices = [
      invoice("Sharma General Store", 60000, 3, -5, "Weekly kirana stock refill", "partial"),
      invoice("Kiran Textiles", 68000, -14, -44, "Grey fabric roll supply", "overdue"),
      invoice("Patel Merchants", 115000, 5, -10, "Oil cartons and FMCG consignment", "active"),
      invoice("National Electricals", 87000, 15, -8, "Cable, switch and panel stock", "paid"),
      invoice("Ravi Bros Hardware", 47000, -21, -48, "Hardware and fastener bundle", "overdue"),
      invoice("Patel Merchants", 25000, -24, -45, "Previous order closure", "paid"),
      invoice("Kiran Textiles", 18000, -50, -80, "Old balance settlement", "paid"),
      invoice("Ravi Bros Hardware", 15000, -42, -62, "Advance settlement", "paid"),
      invoice("Sharma General Store", 22000, -34, -52, "Old weekly supply", "paid")
    ];

    const invoiceFor = (clientName, amount) => invoices.find((item) => item.client_id === byName[clientName].id && item.amount === amount);
    const payment = (clientName, invoiceAmount, amount, days, mode, source, raw_input, confidence, status, number, utr = null, notes = "") => ({
      id: uuid(),
      business_id: business.id,
      client_id: byName[clientName]?.id || null,
      invoice_id: status === "confirmed" && invoiceAmount ? invoiceFor(clientName, invoiceAmount)?.id || null : null,
      amount,
      mode,
      recorded_at: at(days, 11 + Math.floor(Math.random() * 6), Math.floor(Math.random() * 50)),
      source,
      source_number: number,
      raw_input,
      confidence,
      status,
      utr_number: utr,
      notes
    });

    const payments = [
      payment("Sharma General Store", 60000, 10000, -4, "upi", "whatsapp_voice", "Sharma ne das hazaar UPI bheja RAM ke liye", 0.94, "confirmed", "+919876500001", "UPI632118"),
      payment("Sharma General Store", 60000, 7500, -1, "cash", "whatsapp_text", "Received cash 7500 from Sharma General", 0.91, "confirmed", "+919876500002"),
      payment("National Electricals", 87000, 50000, -6, "upi", "whatsapp_image", "UPI screenshot National Electricals 50000 credited", 0.96, "confirmed", "+919876500001", "UTR887650"),
      payment("National Electricals", 87000, 37000, -2, "neft", "manual", "Manual entry after bank reconciliation", 1, "confirmed", "+919876500001", null, "Marked by accountant"),
      payment("Patel Merchants", 25000, 25000, -12, "rtgs", "whatsapp_text", "Patel Merchants cleared previous bill by RTGS 25000", 0.93, "confirmed", "+919876500002", "RTGS2011"),
      payment("Kiran Textiles", 18000, 18000, -28, "cheque", "manual", "Cheque collected against old Kiran balance", 1, "confirmed", "+919876500001"),
      payment("Ravi Bros Hardware", 15000, 15000, -31, "cash", "whatsapp_voice", "Ravi Bros se purana pandrah hazaar cash mila", 0.9, "confirmed", "+919876500002"),
      payment("Sharma General Store", 22000, 22000, -25, "upi", "whatsapp_image", "Screenshot Sharma old invoice paid 22000", 0.95, "confirmed", "+919876500001", "UPI771020"),
      payment("Kiran Textiles", null, 12000, -1, "upi", "whatsapp_text", "Kiran wale bol rahe barah hazaar bheja hai, invoice unsure", 0.73, "pending_review", "+919876500002", "UPI992081"),
      payment("Patel Merchants", null, 8000, 0, "unknown", "whatsapp_voice", "Patel ka kuch eight thousand received maybe cash", 0.68, "pending_review", "+919876500001")
    ];

    const settings = {
      id: "global",
      sse_endpoint: "",
      active_business_id: business.id,
      theme: "dark",
      currency_symbol: "₹",
      connection_log: [
        { at: now, type: "info", message: "Development SSE simulator ready" }
      ]
    };

    const tx = db.transaction(STORES, "readwrite");
    tx.objectStore("businesses").put(business);
    clients.forEach((client) => tx.objectStore("clients").put(client));
    invoices.forEach((item) => tx.objectStore("invoices").put(item));
    payments.forEach((item) => tx.objectStore("payments").put(item));
    tx.objectStore("settings").put(settings);
    await tx.done;
  }

  async function all(storeName) {
    const db = await init();
    return db.getAll(storeName);
  }

  async function getSettings() {
    const db = await init();
    const settings = await db.get("settings", "global");
    if (settings) return settings;
    const businesses = await db.getAll("businesses");
    const fallback = {
      id: "global",
      sse_endpoint: "",
      active_business_id: businesses[0]?.id || null,
      theme: "dark",
      currency_symbol: "₹",
      connection_log: []
    };
    await db.put("settings", fallback);
    return fallback;
  }

  async function saveSettings(patch) {
    const db = await init();
    const settings = await getSettings();
    const next = { ...settings, ...patch };
    await db.put("settings", next);
    return next;
  }

  async function getBusinesses() {
    return all("businesses");
  }

  async function getActiveBusiness() {
    const db = await init();
    const settings = await getSettings();
    if (settings.active_business_id) {
      const active = await db.get("businesses", settings.active_business_id);
      if (active) return active;
    }
    const businesses = await db.getAll("businesses");
    if (!businesses.length) return null;
    await saveSettings({ active_business_id: businesses[0].id });
    return businesses[0];
  }

  async function getActiveBusinessId() {
    return (await getActiveBusiness())?.id || null;
  }

  async function setActiveBusiness(id) {
    return saveSettings({ active_business_id: id });
  }

  async function getClients(businessId) {
    const activeId = businessId || await getActiveBusinessId();
    return (await all("clients")).filter((client) => client.business_id === activeId);
  }

  async function getClient(id) {
    const db = await init();
    return db.get("clients", id);
  }

  async function addClient(data) {
    const db = await init();
    const businessId = data.business_id || await getActiveBusinessId();
    const client = {
      id: uuid(),
      business_id: businessId,
      name: data.name.trim(),
      phone: data.phone.trim(),
      credit_limit: Number(data.credit_limit) || 0,
      payment_cycle_days: Number(data.payment_cycle_days) || 30,
      created_at: Date.now()
    };
    await db.put("clients", client);
    return client;
  }

  async function updateClient(id, patch) {
    const db = await init();
    const client = await db.get("clients", id);
    if (!client) throw new Error("Client not found");
    const next = { ...client, ...patch };
    await db.put("clients", next);
    return next;
  }

  async function getInvoices(businessId) {
    const activeId = businessId || await getActiveBusinessId();
    return (await all("invoices")).filter((invoice) => invoice.business_id === activeId);
  }

  async function getPayments(options = {}) {
    const businessId = options.business_id || await getActiveBusinessId();
    return (await all("payments"))
      .filter((payment) => !businessId || payment.business_id === businessId)
      .filter((payment) => !options.client_id || payment.client_id === options.client_id)
      .filter((payment) => !options.status || payment.status === options.status)
      .sort((a, b) => Number(b.recorded_at) - Number(a.recorded_at));
  }

  async function getBusinessData(businessId) {
    const activeId = businessId || await getActiveBusinessId();
    const [clients, invoices, payments, business, settings] = await Promise.all([
      getClients(activeId),
      getInvoices(activeId),
      getPayments({ business_id: activeId }),
      activeId ? (await init()).get("businesses", activeId) : null,
      getSettings()
    ]);
    return { businessId: activeId, business, clients, invoices, payments, settings };
  }

  function computeInvoice(invoice, confirmedPayments) {
    const paid = confirmedPayments
      .filter((payment) => payment.invoice_id === invoice.id)
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const balance = Math.max(Number(invoice.amount || 0) - paid, 0);
    const dueDays = daysBetween(Date.now(), invoice.due_date);
    let status = "active";
    if (balance <= 0) status = "paid";
    else if (dueDays < 0) status = "overdue";
    else if (paid > 0) status = "partial";
    return { ...invoice, paid, balance, dueDays, status };
  }

  async function computeClientSummaries(businessId) {
    const { clients, invoices, payments } = await getBusinessData(businessId);
    const confirmed = payments.filter((payment) => payment.status === "confirmed");
    return clients.map((client) => {
      const clientInvoices = invoices
        .filter((invoice) => invoice.client_id === client.id)
        .map((invoice) => computeInvoice(invoice, confirmed))
        .sort((a, b) => Number(a.due_date) - Number(b.due_date));
      const clientPayments = confirmed.filter((payment) => payment.client_id === client.id);
      const unpaid = clientInvoices.filter((invoice) => invoice.balance > 0);
      const totalInvoiced = clientInvoices.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
      const totalPaid = clientPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const balance = unpaid.reduce((sum, invoice) => sum + invoice.balance, 0);
      const overdueInvoices = unpaid.filter((invoice) => invoice.dueDays < 0);
      const overdueAmount = overdueInvoices.reduce((sum, invoice) => sum + invoice.balance, 0);
      const dueThisWeekAmount = unpaid
        .filter((invoice) => invoice.dueDays >= 0 && invoice.dueDays <= 7)
        .reduce((sum, invoice) => sum + invoice.balance, 0);
      const nextDue = unpaid.length ? unpaid[0].due_date : null;
      const lastPaymentDate = clientPayments.length ? Math.max(...clientPayments.map((payment) => Number(payment.recorded_at))) : null;
      const paidPercent = totalInvoiced > 0 ? Math.min(100, Math.round((totalPaid / totalInvoiced) * 100)) : 0;
      const hasPartial = unpaid.some((invoice) => invoice.paid > 0);
      const dueSoon = unpaid.some((invoice) => invoice.dueDays >= 0 && invoice.dueDays <= 3);
      let status = "active";
      if (balance <= 0) status = "paid";
      else if (overdueInvoices.length) status = "overdue";
      else if (hasPartial) status = "partial";
      else if (dueSoon) status = "due_soon";
      const worstOverdueDays = overdueInvoices.length ? Math.max(...overdueInvoices.map((invoice) => Math.abs(invoice.dueDays))) : 0;
      const remainingDays = unpaid.length ? Math.min(...unpaid.map((invoice) => invoice.dueDays).filter((days) => days >= 0)) : null;
      return {
        client,
        invoices: clientInvoices,
        payments: clientPayments,
        totalInvoiced,
        totalPaid,
        balance,
        overdueAmount,
        dueThisWeekAmount,
        nextDue,
        lastPaymentDate,
        paidPercent,
        status,
        overdueDays: worstOverdueDays,
        remainingDays
      };
    });
  }

  async function computeMetrics(businessId) {
    const activeId = businessId || await getActiveBusinessId();
    const [summaries, payments] = await Promise.all([
      computeClientSummaries(activeId),
      getPayments({ business_id: activeId })
    ]);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return {
      totalOutstanding: summaries.reduce((sum, item) => sum + item.balance, 0),
      overdue: summaries.reduce((sum, item) => sum + item.overdueAmount, 0),
      dueThisWeek: summaries.reduce((sum, item) => sum + item.dueThisWeekAmount, 0),
      collectedThisMonth: payments
        .filter((payment) => payment.status === "confirmed")
        .filter((payment) => Number(payment.recorded_at) >= monthStart && Number(payment.recorded_at) < monthEnd)
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
    };
  }

  async function getClientLedger(clientId) {
    const [client, summaries, payments] = await Promise.all([
      getClient(clientId),
      computeClientSummaries(),
      getPayments({ client_id: clientId })
    ]);
    const summary = summaries.find((item) => item.client.id === clientId);
    return { client, summary, invoices: summary?.invoices || [], payments };
  }

  async function getOpenInvoicesForClient(clientId) {
    const ledger = await getClientLedger(clientId);
    return ledger.invoices.filter((invoice) => invoice.balance > 0).sort((a, b) => Number(a.due_date) - Number(b.due_date));
  }

  async function chooseInvoiceForPayment(clientId) {
    if (!clientId) return null;
    const openInvoices = await getOpenInvoicesForClient(clientId);
    return openInvoices[0]?.id || null;
  }

  async function addPayment(data) {
    const db = await init();
    const businessId = data.business_id || await getActiveBusinessId();
    const status = data.status || "confirmed";
    let invoiceId = data.invoice_id || null;
    if (status === "confirmed" && data.client_id && !invoiceId) {
      invoiceId = await chooseInvoiceForPayment(data.client_id);
    }
    const payment = {
      id: data.id || uuid(),
      business_id: businessId,
      client_id: data.client_id || null,
      invoice_id: invoiceId,
      amount: Number(data.amount) || 0,
      mode: data.mode || "unknown",
      recorded_at: Number(data.recorded_at) || Date.now(),
      source: data.source || "manual",
      source_number: data.source_number || "",
      raw_input: data.raw_input || data.notes || "Manual entry",
      confidence: Number(data.confidence ?? 1),
      status,
      utr_number: data.utr_number || null,
      notes: data.notes || "",
      business_prefix: data.business_prefix || null,
      client_name: data.client_name || "",
      match_score: Number(data.match_score ?? 0)
    };
    await db.put("payments", payment);
    await refreshInvoiceStatuses(businessId);
    if (!navigator.onLine && status === "confirmed") await queueSyncAction("payment_confirmed", { payment_id: payment.id });
    return payment;
  }

  async function updatePayment(id, patch) {
    const db = await init();
    const current = await db.get("payments", id);
    if (!current) throw new Error("Payment not found");
    const next = { ...current, ...patch };
    await db.put("payments", next);
    await refreshInvoiceStatuses(next.business_id);
    return next;
  }

  async function confirmPayment(id, patch = {}) {
    const db = await init();
    const current = await db.get("payments", id);
    if (!current) throw new Error("Payment not found");
    let next = {
      ...current,
      ...patch,
      amount: Number(patch.amount ?? current.amount) || 0,
      confidence: Number(patch.confidence ?? current.confidence ?? 1),
      status: "confirmed"
    };
    if (next.client_id && !next.invoice_id) {
      next.invoice_id = await chooseInvoiceForPayment(next.client_id);
    }
    await db.put("payments", next);
    await refreshInvoiceStatuses(next.business_id);
    if (!navigator.onLine) await queueSyncAction("payment_confirmed", { payment_id: next.id });
    return next;
  }

  async function discardPayment(id) {
    const db = await init();
    const current = await db.get("payments", id);
    await db.delete("payments", id);
    if (current) {
      await refreshInvoiceStatuses(current.business_id);
      if (!navigator.onLine) await queueSyncAction("payment_discarded", { payment_id: id });
    }
  }

  async function refreshInvoiceStatuses(businessId) {
    const db = await init();
    const [invoices, payments] = await Promise.all([
      getInvoices(businessId),
      getPayments({ business_id: businessId })
    ]);
    const confirmed = payments.filter((payment) => payment.status === "confirmed");
    const tx = db.transaction("invoices", "readwrite");
    invoices.forEach((invoice) => {
      const computed = computeInvoice(invoice, confirmed);
      tx.store.put({ ...invoice, status: computed.status });
    });
    await tx.done;
  }

  async function getPendingPayments() {
    return getPayments({ status: "pending_review" });
  }

  async function saveBusinessSetup(patch) {
    const db = await init();
    const business = await getActiveBusiness();
    if (!business) throw new Error("Business not found");
    const nextBusiness = {
      ...business,
      name: patch.name?.trim() || business.name,
      prefix: patch.prefix?.trim().toUpperCase() || business.prefix
    };
    await db.put("businesses", nextBusiness);
    if (patch.currency_symbol) await saveSettings({ currency_symbol: patch.currency_symbol.trim() });
    if (patch.theme) await saveSettings({ theme: patch.theme });
    return nextBusiness;
  }

  async function addTrustedNumber(phone, label) {
    const db = await init();
    const business = await getActiveBusiness();
    const cleanPhone = phone.trim();
    const numbers = Array.from(new Set([...(business.trusted_numbers || []), cleanPhone]));
    const meta = business.trusted_number_meta || [];
    if (!meta.some((item) => item.phone === cleanPhone)) {
      meta.push({ phone: cleanPhone, label: label || "Staff", active: true, last_message_at: null, created_at: Date.now() });
    }
    const next = { ...business, trusted_numbers: numbers, trusted_number_meta: meta };
    await db.put("businesses", next);
    return next;
  }

  async function removeTrustedNumber(phone) {
    const db = await init();
    const business = await getActiveBusiness();
    const next = {
      ...business,
      trusted_numbers: (business.trusted_numbers || []).filter((item) => item !== phone),
      trusted_number_meta: (business.trusted_number_meta || []).filter((item) => item.phone !== phone)
    };
    await db.put("businesses", next);
    return next;
  }

  async function toggleTrustedNumber(phone, active) {
    const db = await init();
    const business = await getActiveBusiness();
    const next = {
      ...business,
      trusted_number_meta: (business.trusted_number_meta || []).map((item) => item.phone === phone ? { ...item, active } : item)
    };
    await db.put("businesses", next);
    return next;
  }

  async function getTrustedNumberStats() {
    const [business, payments] = await Promise.all([getActiveBusiness(), getPayments()]);
    const meta = business?.trusted_number_meta || [];
    return meta.map((item) => {
      const byNumber = payments.filter((payment) => payment.source_number === item.phone);
      return {
        ...item,
        paymentCount: byNumber.length,
        last_message_at: item.last_message_at || (byNumber[0]?.recorded_at ?? null)
      };
    });
  }

  async function appendConnectionLog(message, type = "info") {
    const settings = await getSettings();
    const connection_log = [
      { at: Date.now(), type, message },
      ...(settings.connection_log || [])
    ].slice(0, 5);
    await saveSettings({ connection_log });
    return connection_log;
  }

  async function snapshot() {
    const db = await init();
    const stores = {};
    for (const name of STORES.filter((store) => store !== "sync_queue")) {
      stores[name] = await db.getAll(name);
    }
    return {
      app: "WholesaleLedger",
      version: DB_VERSION,
      exported_at: Date.now(),
      stores
    };
  }

  async function importSnapshot(payload) {
    if (!payload?.stores) throw new Error("Invalid backup file");
    const db = await init();
    const tx = db.transaction(STORES, "readwrite");
    STORES.forEach((store) => tx.objectStore(store).clear());
    await tx.done;
    const write = db.transaction(STORES, "readwrite");
    for (const storeName of Object.keys(payload.stores)) {
      if (!STORES.includes(storeName)) continue;
      payload.stores[storeName].forEach((item) => write.objectStore(storeName).put(item));
    }
    await write.done;
  }

  async function clearActiveBusinessData() {
    const db = await init();
    const businessId = await getActiveBusinessId();
    const [clients, invoices, payments] = await Promise.all([
      getClients(businessId),
      getInvoices(businessId),
      getPayments({ business_id: businessId })
    ]);
    const tx = db.transaction(["clients", "invoices", "payments"], "readwrite");
    clients.forEach((client) => tx.objectStore("clients").delete(client.id));
    invoices.forEach((invoice) => tx.objectStore("invoices").delete(invoice.id));
    payments.forEach((payment) => tx.objectStore("payments").delete(payment.id));
    await tx.done;
  }

  async function clearPayments() {
    const db = await init();
    const businessId = await getActiveBusinessId();
    const payments = await getPayments({ business_id: businessId });
    const tx = db.transaction("payments", "readwrite");
    payments.forEach((payment) => tx.store.delete(payment.id));
    await tx.done;
    await refreshInvoiceStatuses(businessId);
  }

  async function deleteActiveBusiness() {
    const db = await init();
    const businessId = await getActiveBusinessId();
    await clearActiveBusinessData();
    await db.delete("businesses", businessId);
    const remaining = await db.getAll("businesses");
    if (remaining.length) {
      await saveSettings({ active_business_id: remaining[0].id });
      return remaining[0];
    }
    const newBusiness = {
      id: uuid(),
      name: "New Business",
      prefix: "NEW",
      trusted_numbers: [],
      trusted_number_meta: [],
      created_at: Date.now()
    };
    await db.put("businesses", newBusiness);
    await saveSettings({ active_business_id: newBusiness.id });
    return newBusiness;
  }

  async function queueSyncAction(type, payload) {
    const db = await init();
    const action = { id: uuid(), type, payload, status: "queued", created_at: Date.now() };
    await db.put("sync_queue", action);
    if ("serviceWorker" in navigator && "SyncManager" in window) {
      try {
        const registration = await navigator.serviceWorker.ready;
        await registration.sync.register("sync-payment-confirmations");
      } catch (error) {
        console.warn("Background sync registration failed", error);
      }
    }
    return action;
  }

  function formatCurrency(amount, symbol = "₹") {
    const value = Number(amount) || 0;
    const sign = value < 0 ? "-" : "";
    return `${sign}${symbol}${Math.abs(Math.round(value)).toLocaleString("en-IN")}`;
  }

  function startOfDay(value) {
    const date = new Date(Number(value));
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function daysBetween(from, to) {
    return Math.ceil((startOfDay(to) - startOfDay(from)) / DAY);
  }

  function formatDateContext(value) {
    if (!value) return "Not set";
    const date = new Date(Number(value));
    const today = startOfDay(Date.now());
    const target = startOfDay(date.getTime());
    const diff = Math.round((target - today) / DAY);
    const time = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(date);
    if (diff === 0) return `Today ${time}`;
    if (diff === -1) return `Yesterday ${time}`;
    const options = date.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
    return new Intl.DateTimeFormat("en-IN", options).format(date);
  }

  function timeAgo(value) {
    const diff = Date.now() - Number(value);
    if (diff < 60 * 1000) return "Just now";
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < DAY) return `${Math.floor(diff / 3600000)} hr ago`;
    return `${Math.floor(diff / DAY)}d ago`;
  }

  function statusLabel(status, days) {
    if (status === "paid") return "Paid";
    if (status === "due_soon") return "Due soon";
    if (status === "overdue") return days ? `${days}d overdue` : "Overdue";
    if (status === "partial") return "Partial";
    return "Active";
  }

  function statusClass(status) {
    return {
      paid: "status-paid",
      due_soon: "status-due-soon",
      overdue: "status-overdue",
      partial: "status-partial",
      active: "status-neutral"
    }[status] || "status-neutral";
  }

  function confidenceClass(value) {
    const score = Number(value);
    if (score > 0.9) return "confidence-high";
    if (score >= 0.7) return "confidence-medium";
    return "confidence-low";
  }

  function sourceLabel(source) {
    return {
      whatsapp_voice: "Voice",
      whatsapp_text: "Text",
      whatsapp_image: "Image",
      manual: "Manual"
    }[source] || "Unknown";
  }

  function normalizeName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\b(store|traders|trading|merchant|merchants|textiles|general|hardware|bros|brothers|electricals)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function levenshtein(a, b) {
    const matrix = Array.from({ length: b.length + 1 }, (_, index) => [index]);
    for (let index = 0; index <= a.length; index += 1) matrix[0][index] = index;
    for (let row = 1; row <= b.length; row += 1) {
      for (let col = 1; col <= a.length; col += 1) {
        if (b.charAt(row - 1) === a.charAt(col - 1)) matrix[row][col] = matrix[row - 1][col - 1];
        else matrix[row][col] = Math.min(matrix[row - 1][col - 1] + 1, matrix[row][col - 1] + 1, matrix[row - 1][col] + 1);
      }
    }
    return matrix[b.length][a.length];
  }

  function scoreNames(input, candidate) {
    const a = normalizeName(input);
    const b = normalizeName(candidate);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.92;
    const distance = levenshtein(a, b);
    const base = 1 - distance / Math.max(a.length, b.length);
    const tokensA = new Set(a.split(" ").filter(Boolean));
    const tokensB = new Set(b.split(" ").filter(Boolean));
    const overlap = [...tokensA].filter((token) => tokensB.has(token)).length / Math.max(tokensA.size, tokensB.size, 1);
    return Math.max(0, Math.min(1, (base * 0.72) + (overlap * 0.28)));
  }

  async function fuzzyMatchClient(clientName, businessId) {
    const clients = await getClients(businessId);
    const matches = clients
      .map((client) => ({ client, score: scoreNames(clientName, client.name) }))
      .sort((a, b) => b.score - a.score);
    return matches[0] || { client: null, score: 0 };
  }

  window.WLDB = {
    init,
    uuid,
    getSettings,
    saveSettings,
    getBusinesses,
    getActiveBusiness,
    setActiveBusiness,
    getClients,
    getClient,
    addClient,
    updateClient,
    getInvoices,
    getPayments,
    getPendingPayments,
    getBusinessData,
    getClientLedger,
    getOpenInvoicesForClient,
    computeClientSummaries,
    computeMetrics,
    addPayment,
    updatePayment,
    confirmPayment,
    discardPayment,
    saveBusinessSetup,
    addTrustedNumber,
    removeTrustedNumber,
    toggleTrustedNumber,
    getTrustedNumberStats,
    appendConnectionLog,
    snapshot,
    importSnapshot,
    clearActiveBusinessData,
    clearPayments,
    deleteActiveBusiness,
    queueSyncAction,
    fuzzyMatchClient,
    formatCurrency,
    formatDateContext,
    timeAgo,
    statusLabel,
    statusClass,
    confidenceClass,
    sourceLabel,
    daysBetween
  };
})();
