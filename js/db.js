(function () {
  const DB_NAME = "WholesaleLedgerDB";
  const DB_VERSION = 1;
  const DAY = 24 * 60 * 60 * 1000;
  const isLocalHost = ["localhost", "127.0.0.1", ""].includes(window.location.hostname);
  const DEFAULT_SSE_ENDPOINT = isLocalHost
    ? "http://127.0.0.1:3000/sse"
    : "https://smirk-blighted-marvelous.ngrok-free.dev/sse";
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

  let detectedApiBaseUrl = null;

  async function probeBackend(port) {
    if (!port) return null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 400);
      const url = `http://127.0.0.1:${port}`;
      const res = await fetch(`${url}/api/health`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) return url;
    } catch (e) {}
    return null;
  }

  async function getApiBaseUrl() {
    if (detectedApiBaseUrl) return detectedApiBaseUrl;

    if (isLocalHost) {
      // 1. Try current window port
      if (window.location.port) {
        const url = await probeBackend(window.location.port);
        if (url) {
          detectedApiBaseUrl = url;
          return url;
        }
      }
      // 2. Try port 3000
      const url3000 = await probeBackend("3000");
      if (url3000) {
        detectedApiBaseUrl = url3000;
        return url3000;
      }
      // 3. Try port 8080
      const url8080 = await probeBackend("8080");
      if (url8080) {
        detectedApiBaseUrl = url8080;
        return url8080;
      }
    }

    const db = await openDatabase();
    const settings = await db.get("settings", "global");
    if (settings && settings.sse_endpoint) {
      const url = settings.sse_endpoint.replace(/\/sse\/?$/, "");
      if (url) return url;
    }
    return "";
  }

  async function apiFetch(path, options = {}) {
    const baseUrl = await getApiBaseUrl();
    if (!baseUrl) {
      console.warn("No API base URL configured, skipping fetch for", path);
      return null;
    }
    const url = `${baseUrl}${path}`;
    const defaultHeaders = {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "69420"
    };
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...defaultHeaders,
          ...options.headers
        }
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText || response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error("API call failed:", error);
      throw error;
    }
  }

  async function pullSync() {
    if (!navigator.onLine) {
      console.warn("Offline, skipping pull sync");
      return;
    }
    try {
      console.log("Starting pull sync...");
      const activeId = await getActiveBusinessId();
      const activeBusiness = activeId ? (await (await openDatabase()).get("businesses", activeId)) : null;
      let businessData = await apiFetch("/api/business");

      if (activeBusiness && (!businessData.business || !businessData.business.name || !businessData.business.prefix || businessData.business.id !== activeId)) {
        console.log("Backend business is empty or mismatched, pushing active business setup...");
        try {
          const updatedBiz = await apiFetch("/api/business", {
            method: "PUT",
            body: JSON.stringify(activeBusiness)
          });
          businessData = { business: updatedBiz };
        } catch (err) {
          console.warn("Failed to push active business setup to backend:", err);
        }
      }

      const clientsData = await apiFetch("/api/clients");
      const txData = await apiFetch("/api/transactions");
      if (!businessData || !clientsData || !txData) {
        console.warn("Pull sync fetched empty data, aborting");
        return;
      }
      const mappedBusinessId = activeId || businessData.business.id || "";
      const db = await openDatabase();
      const tx = db.transaction(["businesses", "clients", "invoices", "payments"], "readwrite");
      const bStore = tx.objectStore("businesses");
      await bStore.clear();
      await bStore.put({ ...businessData.business, id: mappedBusinessId, synced: true, updated_at: new Date().toISOString() });
      const cStore = tx.objectStore("clients");
      await cStore.clear();
      for (const client of clientsData.clients) {
        await cStore.put({ ...client, business_id: mappedBusinessId, synced: true, updated_at: new Date().toISOString() });
      }
      const iStore = tx.objectStore("invoices");
      const pStore = tx.objectStore("payments");
      await iStore.clear();
      await pStore.clear();
      for (const trans of txData.transactions) {
        if (trans.type === "goods") {
          const invoice = {
            id: trans.transaction_id || trans.id,
            business_id: mappedBusinessId,
            client_id: trans.client_id,
            amount: Number(trans.amount) || 0,
            due_date: Number(
              trans.due_date ||
              trans.due_date_at_transaction ||
              trans.recorded_at + Number(trans.credit_days || (clientsData.clients.find(c => c.id === trans.client_id)?.payment_cycle_days) || 30) * DAY
            ),
            created_at: Number(trans.recorded_at),
            notes: trans.description || trans.raw_input || "WhatsApp goods entry",
            status: trans.status || "confirmed",
            source: trans.source || "whatsapp_text",
            source_number: trans.source_number || "",
            raw_input: trans.raw_input || "",
            confidence: Number(trans.confidence ?? 1),
            transaction_id: trans.transaction_id || trans.id || null,
            business_prefix: trans.business_prefix || null,
            client_name: trans.client_name || ""
          };
          await iStore.put({ ...invoice, synced: true, updated_at: new Date().toISOString() });
        } else if (trans.type === "payment") {
          const payment = {
            id: trans.id,
            business_id: mappedBusinessId,
            client_id: trans.client_id,
            invoice_id: trans.invoice_id || null,
            amount: Number(trans.amount) || 0,
            mode: trans.mode || "unknown",
            recorded_at: Number(trans.recorded_at),
            source: trans.source || "manual",
            source_number: trans.source_number || "",
            raw_input: trans.raw_input || "",
            confidence: Number(trans.confidence ?? 1),
            status: trans.status || "confirmed",
            utr_number: trans.utr_number || null,
            notes: trans.notes || "",
            business_prefix: trans.business_prefix || null,
            client_name: trans.client_name || "",
            match_score: Number(trans.match_score ?? 1)
          };
          await pStore.put({ ...payment, synced: true, updated_at: new Date().toISOString() });
        }
      }
      await tx.done;
      await refreshInvoiceStatuses(mappedBusinessId);
      console.log("Pull sync completed successfully!");
      window.dispatchEvent(new CustomEvent("wl:sync-completed"));
    } catch (error) {
      console.error("Pull sync failed:", error);
    }
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

  async function runAuthCheck(activeBusiness) {
    const currentPath = window.location.pathname;
    const isLoginPage = currentPath.endsWith("login.html") || currentPath.endsWith("signup.html") || currentPath.endsWith("sso-mock.html");
    const isOnboardingPage = currentPath.endsWith("onboarding.html");
    let user = localStorage.getItem("wl_user");

    if (user && window.WLAuth) {
      try {
        const authed = await window.WLAuth.isAuthenticated();
        if (!authed) {
          localStorage.removeItem("wl_user");
          user = null;
        }
      } catch (e) {
        console.warn("[AuthCheck] Supabase session check failed:", e);
      }
    }

    if (!user) {
      if (!isLoginPage) {
        window.location.href = "login.html";
      }
    } else {
      if (!activeBusiness) {
        if (!isOnboardingPage && !isLoginPage) {
          window.location.href = "onboarding.html";
        }
      } else {
        if (isLoginPage || isOnboardingPage) {
          window.location.href = "index.html";
        }
      }
    }
  }

  let initPromise;
  async function init() {
    if (!initPromise) {
      initPromise = (async () => {
        const db = await openDatabase();
        if (!seedPromise) seedPromise = seedIfNeeded();
        await seedPromise;
        const activeBusiness = await getActiveBusiness();
        await runAuthCheck(activeBusiness);
        if (activeBusiness && navigator.onLine) {
          pullSync().catch(console.error);
        }
        if (activeBusiness && window.WLSync) {
          window.WLSync.start();
        }
        return db;
      })();
    }
    return initPromise;
  }

  async function seedIfNeeded() {
    const db = await openDatabase();
    const count = await db.count("settings");
    if (count > 0) return;

    const now = Date.now();
    const settings = {
      id: "global",
      sse_endpoint: DEFAULT_SSE_ENDPOINT,
      sse_endpoint_manual_clear: false,
      active_business_id: null,
      theme: "dark",
      currency_symbol: "₹",
      connection_log: [
        { at: now, type: "info", message: "Development SSE connection ready" }
      ]
    };

    const tx = db.transaction(STORES, "readwrite");
    tx.objectStore("settings").put(settings);
    await tx.done;
  }

  async function all(storeName) {
    const db = await init();
    return db.getAll(storeName);
  }

  async function getSettings() {
    if (!seedPromise) seedPromise = seedIfNeeded();
    await seedPromise;
    const db = await openDatabase();
    const settings = await db.get("settings", "global");
    let resolvedDefaultEndpoint = DEFAULT_SSE_ENDPOINT;
    if (isLocalHost) {
      const baseUrl = await getApiBaseUrl();
      resolvedDefaultEndpoint = baseUrl ? `${baseUrl}/sse` : "http://127.0.0.1:3000/sse";
    }
    if (settings) {
      // If the endpoint is pointing to the old trycloudflare or old railway, migrate it to the active endpoint
      if (settings.sse_endpoint && (settings.sse_endpoint.includes("trycloudflare.com") || settings.sse_endpoint.includes("railway.app"))) {
        settings.sse_endpoint = resolvedDefaultEndpoint;
        await db.put("settings", settings);
      }
      if (!settings.sse_endpoint && !settings.sse_endpoint_manual_clear) {
        const next = { ...settings, sse_endpoint: resolvedDefaultEndpoint, sse_endpoint_manual_clear: false };
        await db.put("settings", next);
        return next;
      }
      return settings;
    }
    const businesses = await db.getAll("businesses");
    const fallback = {
      id: "global",
      sse_endpoint: resolvedDefaultEndpoint,
      sse_endpoint_manual_clear: false,
      active_business_id: businesses[0]?.id || null,
      theme: "dark",
      currency_symbol: "₹",
      connection_log: []
    };
    await db.put("settings", fallback);
    return fallback;
  }

  async function saveSettings(patch) {
    const db = await openDatabase();
    const settings = await getSettings();
    const next = { ...settings, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, "sse_endpoint")) {
      next.sse_endpoint_manual_clear = !patch.sse_endpoint;
    }
    await db.put("settings", next);
    return next;
  }

  async function getBusinesses() {
    return all("businesses");
  }

  async function getActiveBusiness() {
    const db = await openDatabase();
    const settings = await getSettings();
    if (settings && settings.active_business_id) {
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
    if (!id || (typeof id !== "string" && typeof id !== "number")) return null;
    const db = await init();
    return db.get("clients", id);
  }

  async function addClient(data) {
    const db = await init();
    const businessId = data.business_id || await getActiveBusinessId();
    const client = {
      id: data.id || uuid(),
      business_id: businessId,
      name: data.name.trim(),
      phone: data.phone.trim(),
      credit_limit: Number(data.credit_limit) || 0,
      payment_cycle_days: Number(data.payment_cycle_days) || 30,
      created_at: Date.now(),
      synced: false,
      updated_at: new Date().toISOString()
    };
    await db.put("clients", client);
    if (navigator.onLine) {
      try {
        await apiFetch("/api/clients", {
          method: "POST",
          body: JSON.stringify(client)
        });
      } catch (error) {
        console.warn("Failed to push client to server, queueing:", error);
        await queueSyncAction("client_added", client);
      }
    } else {
      await queueSyncAction("client_added", client);
    }
    return client;
  }

  async function updateClient(id, patch) {
    const db = await init();
    const client = await db.get("clients", id);
    if (!client) throw new Error("Client not found");
    const next = { ...client, ...patch, synced: false, updated_at: new Date().toISOString() };
    await db.put("clients", next);
    return next;
  }

  async function updateClientLocally(client) {
    const db = await init();
    const activeId = await getActiveBusinessId();
    const existing = await db.get("clients", client.id);
    const merged = {
      ...existing,
      ...client,
      business_id: client.business_id && client.business_id !== "" ? client.business_id : (activeId || ""),
      synced: true,
      updated_at: new Date().toISOString()
    };
    await db.put("clients", merged);
    return merged;
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
        .filter((invoice) => invoice.client_id === client.id && invoice.status !== "pending_review")
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
    if (!clientId) {
      return { client: null, summary: null, invoices: [], payments: [] };
    }
    const [client, summaries, payments] = await Promise.all([
      getClient(clientId),
      computeClientSummaries(),
      getPayments({ client_id: clientId })
    ]);
    const summary = summaries.find((item) => item.client.id === clientId);
    return { client, summary, invoices: summary?.invoices || [], payments };
  }

  async function getOpenInvoicesForClient(clientId) {
    if (!clientId) return [];
    const ledger = await getClientLedger(clientId);
    return ledger.invoices.filter((invoice) => invoice.balance > 0).sort((a, b) => Number(a.due_date) - Number(b.due_date));
  }

  async function chooseInvoiceForPayment(clientId) {
    if (!clientId) return null;
    const openInvoices = await getOpenInvoicesForClient(clientId);
    return openInvoices[0]?.id || null;
  }

  async function addInvoice(data) {
    const db = await init();
    const businessId = data.business_id || await getActiveBusinessId();
    const clientId = data.client_id || null;
    const recordedAt = Number(data.recorded_at) || Date.now();
    const client = clientId ? await getClient(clientId) : null;
    const cycleDays = Number(data.credit_days || client?.payment_cycle_days || 30);
    const dueDate = Number(data.due_date || data.due_date_at_transaction)
      || recordedAt + cycleDays * DAY;
    const invoice = {
      id: data.id || data.transaction_id || uuid(),
      business_id: businessId,
      client_id: clientId,
      amount: Number(data.amount) || 0,
      due_date: dueDate,
      created_at: recordedAt,
      notes: data.description || data.raw_input || data.notes || "WhatsApp goods entry",
      status: data.status === "confirmed" ? "active" : "pending_review",
      source: data.source || "whatsapp_text",
      source_number: data.source_number || "",
      raw_input: data.raw_input || "",
      confidence: Number(data.confidence ?? 1),
      transaction_id: data.transaction_id || data.id || null,
      business_prefix: data.business_prefix || null,
      client_name: data.client_name || "",
      synced: false,
      updated_at: new Date().toISOString()
    };
    await db.put("invoices", invoice);
    await refreshInvoiceStatuses(businessId);
    return invoice;
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
      match_score: Number(data.match_score ?? 0),
      synced: false,
      updated_at: new Date().toISOString()
    };
    await db.put("payments", payment);
    await refreshInvoiceStatuses(businessId);
    if (data.skipPush) {
      return payment;
    }
    if (navigator.onLine) {
      try {
        await apiFetch("/api/payments", {
          method: "POST",
          body: JSON.stringify(payment)
        });
      } catch (error) {
        console.warn("Failed to push payment to server, queuing:", error);
        await queueSyncAction("payment_added", payment);
      }
    } else {
      await queueSyncAction("payment_added", payment);
    }
    return payment;
  }

  async function updatePayment(id, patch) {
    const db = await init();
    const current = await db.get("payments", id);
    if (!current) throw new Error("Payment not found");
    const next = { ...current, ...patch, synced: false, updated_at: new Date().toISOString() };
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
      status: "confirmed",
      synced: false,
      updated_at: new Date().toISOString()
    };
    if (next.client_id && !next.invoice_id) {
      next.invoice_id = await chooseInvoiceForPayment(next.client_id);
    }
    await db.put("payments", next);
    await refreshInvoiceStatuses(next.business_id);
    if (navigator.onLine) {
      try {
        await apiFetch(`/api/payments/${id}/confirm`, {
          method: "PUT",
          body: JSON.stringify(next)
        });
      } catch (error) {
        console.warn("Failed to push confirm payment to server, queuing:", error);
        await queueSyncAction("payment_confirmed", next);
      }
    } else {
      await queueSyncAction("payment_confirmed", next);
    }
    return next;
  }

  async function discardPayment(id) {
    const db = await init();
    const current = await db.get("payments", id);
    await db.delete("payments", id);
    if (current) {
      await refreshInvoiceStatuses(current.business_id);
      if (navigator.onLine) {
        try {
          await apiFetch(`/api/payments/${id}`, {
            method: "DELETE"
          });
        } catch (error) {
          console.warn("Failed to push discard payment to server, queuing:", error);
          await queueSyncAction("payment_discarded", { payment_id: id });
        }
      } else {
        await queueSyncAction("payment_discarded", { payment_id: id });
      }
    }
  }

  async function confirmInvoice(id, patch = {}) {
    const db = await init();
    const current = await db.get("invoices", id);
    if (!current) throw new Error("Invoice not found");
    const next = {
      ...current,
      ...patch,
      amount: Number(patch.amount ?? current.amount) || 0,
      credit_days: patch.credit_days !== undefined ? patch.credit_days : current.credit_days,
      confidence: Number(patch.confidence ?? current.confidence ?? 1),
      status: "confirmed",
      synced: false,
      updated_at: new Date().toISOString()
    };
    const client = next.client_id ? await getClient(next.client_id) : null;
    const cycleDays = Number(next.credit_days || client?.payment_cycle_days || 30);
    next.due_date = Number(patch.due_date || next.due_date_at_transaction)
      || Number(next.created_at || next.recorded_at) + cycleDays * DAY;
      
    await db.put("invoices", next);
    await refreshInvoiceStatuses(next.business_id);
    
    if (navigator.onLine) {
      try {
        await apiFetch(`/api/transactions/${id}/confirm`, {
          method: "PUT",
          body: JSON.stringify(next)
        });
      } catch (error) {
        console.warn("Failed to push confirm invoice to server, queuing:", error);
        await queueSyncAction("transaction_confirmed", next);
      }
    } else {
      await queueSyncAction("transaction_confirmed", next);
    }
    return next;
  }

  async function discardInvoice(id) {
    const db = await init();
    const current = await db.get("invoices", id);
    await db.delete("invoices", id);
    if (current) {
      await refreshInvoiceStatuses(current.business_id);
      if (navigator.onLine) {
        try {
          await apiFetch(`/api/transactions/${id}`, {
            method: "DELETE"
          });
        } catch (error) {
          console.warn("Failed to push discard invoice to server, queuing:", error);
          await queueSyncAction("transaction_deleted", { transaction_id: id });
        }
      } else {
        await queueSyncAction("transaction_deleted", { transaction_id: id });
      }
    }
  }

  async function deletePaymentLocally(id) {
    if (!id) return;
    const db = await init();
    const current = await db.get("payments", id);
    await db.delete("payments", id);
    if (current) {
      await refreshInvoiceStatuses(current.business_id);
    }
  }

  async function deleteInvoiceLocally(id) {
    if (!id) return;
    const db = await init();
    const current = await db.get("invoices", id);
    await db.delete("invoices", id);
    if (current) {
      await refreshInvoiceStatuses(current.business_id);
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
      if (invoice.status === "pending_review") return;
      const computed = computeInvoice(invoice, confirmed);
      tx.store.put({ ...invoice, status: computed.status });
    });
    await tx.done;
  }

  async function getPendingInvoices(businessId) {
    const activeId = businessId || await getActiveBusinessId();
    return (await all("invoices"))
      .filter((invoice) => invoice.business_id === activeId && invoice.status === "pending_review");
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
      prefix: patch.prefix?.trim().toUpperCase() || business.prefix,
      synced: false,
      updated_at: new Date().toISOString()
    };
    await db.put("businesses", nextBusiness);
    if (patch.currency_symbol) await saveSettings({ currency_symbol: patch.currency_symbol.trim() });
    if (patch.theme) await saveSettings({ theme: patch.theme });
    if (navigator.onLine) {
      try {
        await apiFetch("/api/business", {
          method: "PUT",
          body: JSON.stringify(nextBusiness)
        });
      } catch (error) {
        console.warn("Failed to push business setup to server:", error);
      }
    }
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
    if (navigator.onLine) {
      try {
        await apiFetch("/api/trusted-numbers", {
          method: "POST",
          body: JSON.stringify({ phone: cleanPhone, label: label || "Staff" })
        });
      } catch (error) {
        console.warn("Failed to push trusted number to server:", error);
      }
    }
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
    if (navigator.onLine) {
      try {
        await apiFetch(`/api/trusted-numbers/${encodeURIComponent(phone)}`, {
          method: "DELETE"
        });
      } catch (error) {
        console.warn("Failed to remove trusted number on server:", error);
      }
    }
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
    if (navigator.onLine) {
      try {
        await apiFetch(`/api/trusted-numbers/${encodeURIComponent(phone)}/toggle`, {
          method: "PUT",
          body: JSON.stringify({ active })
        });
      } catch (error) {
        console.warn("Failed to toggle trusted number on server:", error);
      }
    }
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

  async function clearLocalLedgerData() {
    const db = await openDatabase();
    const tx = db.transaction(["businesses", "clients", "invoices", "payments", "sync_queue"], "readwrite");
    await tx.objectStore("businesses").clear();
    await tx.objectStore("clients").clear();
    await tx.objectStore("invoices").clear();
    await tx.objectStore("payments").clear();
    await tx.objectStore("sync_queue").clear();
    await tx.done;
    await saveSettings({ active_business_id: null });
    localStorage.removeItem('wl_last_sync_time');
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

  async function createBusiness(data) {
    const db = await openDatabase();
    const business = {
      id: uuid(),
      name: data.name.trim(),
      prefix: data.prefix.trim().toUpperCase(),
      trusted_numbers: [],
      trusted_number_meta: [],
      created_at: Date.now(),
      synced: false,
      updated_at: new Date().toISOString()
    };
    await db.put("businesses", business);
    await saveSettings({ 
      active_business_id: business.id,
      currency_symbol: data.currency_symbol || "₹"
    });
    const tx = db.transaction(["clients", "invoices", "payments"], "readwrite");
    await tx.objectStore("clients").clear();
    await tx.objectStore("invoices").clear();
    await tx.objectStore("payments").clear();
    await tx.done;
    if (navigator.onLine) {
      try {
        await apiFetch("/api/reset", { method: "POST" });
        await apiFetch("/api/business", {
          method: "PUT",
          body: JSON.stringify(business)
        });
      } catch (error) {
        console.warn("Failed to push newly created business/reset to server:", error);
      }
    }
    return business;
  }

  window.WLDB = {
    init,
    getApiBaseUrl,
    pullSync,
    uuid,
    getSettings,
    saveSettings,
    getBusinesses,
    getActiveBusiness,
    setActiveBusiness,
    createBusiness,
    getClients,
    getClient,
    addClient,
    updateClient,
    updateClientLocally,
    getInvoices,
    getPendingInvoices,
    getPayments,
    getPendingPayments,
    getBusinessData,
    getClientLedger,
    getOpenInvoicesForClient,
    computeClientSummaries,
    computeMetrics,
    addInvoice,
    addPayment,
    updatePayment,
    confirmPayment,
    discardPayment,
    confirmInvoice,
    discardInvoice,
    deletePaymentLocally,
    deleteInvoiceLocally,
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
    clearLocalLedgerData,
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
