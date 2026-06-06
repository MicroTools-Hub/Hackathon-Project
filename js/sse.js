(function () {
  let eventSource = null;
  let reconnectTimer = null;
  let simulatorTimer = null;
  let retryDelay = 1000;
  const MAX_RETRY = 30000;

  async function start() {
    await window.WLDB.init();
    const settings = await window.WLDB.getSettings();
    stop();

    let endpoint = settings.sse_endpoint;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600);
      const res = await fetch("http://127.0.0.1:3000/api/health", { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) endpoint = "http://127.0.0.1:3000/sse";
    } catch (e) {}

    if (endpoint && navigator.onLine) {
      connect(endpoint);
      return;
    }
    if (isDevelopment()) startSimulator();
    else setStatus("offline", "Offline");
  }

  function stop() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    if (simulatorTimer) window.clearTimeout(simulatorTimer);
  }

  function connect(endpoint) {
    setStatus("offline", "Connecting");
    try {
      eventSource = new EventSource(endpoint);
    } catch (error) {
      scheduleReconnect(endpoint, error);
      return;
    }

    eventSource.onopen = async () => {
      retryDelay = 1000;
      setStatus("live", "Live");
      await window.WLDB.appendConnectionLog("SSE connection opened", "success");
      if (window.WLDB && window.WLDB.pullSync) {
        window.WLDB.pullSync().catch(console.error);
      }
    };

    eventSource.addEventListener("payment", (event) => {
      safelyHandlePayment(parseEventData(event));
    });

    eventSource.addEventListener("transaction", (event) => {
      safelyHandleTransaction(parseEventData(event));
    });

    eventSource.onmessage = (event) => {
      routeServerEvent(parseEventData(event));
    };

    eventSource.addEventListener("reminder", async (event) => {
      const payload = parseEventData(event);
      window.WLNotify.info("Reminder sent", payload?.client_name || "WhatsApp delivery confirmed");
      window.dispatchEvent(new CustomEvent("wl:reminder", { detail: payload }));
    });

    eventSource.addEventListener("error", (event) => {
      if (!event.data) return;
      const payload = parseEventData(event);
      window.WLNotify.error("Extraction failed", payload?.message || "AI extraction could not be completed");
      window.dispatchEvent(new CustomEvent("wl:sse-error", { detail: payload }));
    });

    eventSource.onerror = async (error) => {
      if (eventSource) eventSource.close();
      eventSource = null;
      setStatus("offline", "Offline");
      window.WLNotify.error("Connection lost", "Working offline");
      await window.WLDB.appendConnectionLog("SSE connection dropped", "error");
      scheduleReconnect(endpoint, error);
    };
  }

  function scheduleReconnect(endpoint) {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      if (navigator.onLine) connect(endpoint);
      retryDelay = Math.min(MAX_RETRY, retryDelay * 2);
    }, retryDelay);
  }

  function parseEventData(event) {
    try {
      return event?.data ? JSON.parse(event.data) : {};
    } catch (error) {
      return { message: event?.data || "" };
    }
  }

  function safelyHandlePayment(payload) {
    handlePayment(payload).catch((error) => {
      console.error("Payment event failed", error);
      window.WLNotify.error("Payment event failed", error.message);
    });
  }

  function safelyHandleTransaction(payload) {
    handleTransaction(payload).catch((error) => {
      console.error("Transaction event failed", error);
      window.WLNotify.error("Transaction event failed", error.message);
    });
  }

  function routeServerEvent(payload) {
    const type = payload?.type;
    const data = payload?.data || payload || {};
    if (type === "payment") {
      safelyHandlePayment(payload);
    } else if (type === "transaction") {
      safelyHandleTransaction(payload);
    } else if (type === "reminder") {
      window.WLNotify.info("Reminder sent", data?.client_name || "WhatsApp delivery confirmed");
      window.dispatchEvent(new CustomEvent("wl:reminder", { detail: data }));
    } else if (type === "credit_limit_alert") {
      window.WLNotify.warning("Credit limit alert", data?.message || "Owner approval is required");
      window.dispatchEvent(new CustomEvent("wl:credit-limit-alert", { detail: data }));
    } else if (type === "rating_alert") {
      window.WLNotify.warning("Client rating changed", data?.client_name || "A client moved to risky");
      window.dispatchEvent(new CustomEvent("wl:rating-alert", { detail: data }));
    } else if (type === "error") {
      window.WLNotify.error("Extraction failed", data?.message || "AI extraction could not be completed");
      window.dispatchEvent(new CustomEvent("wl:sse-error", { detail: data }));
    } else if (type === "connection") {
      window.dispatchEvent(new CustomEvent("wl:backend-connection", { detail: data }));
    } else if (type === "whatsapp_status") {
      window.dispatchEvent(new CustomEvent("wl:whatsapp-status", { detail: data }));
    } else if (type === "snapshot") {
      window.dispatchEvent(new CustomEvent("wl:snapshot", { detail: data }));
    } else if (type === "payment_deleted") {
      safelyHandleDeletePayment(data);
    } else if (type === "transaction_deleted") {
      safelyHandleDeleteTransaction(data);
    }
  }

  function safelyHandleDeletePayment(data) {
    const paymentId = data.payment_id || data.id;
    if (!paymentId) return;
    window.WLDB.deletePaymentLocally(paymentId)
      .then(() => {
        window.dispatchEvent(new CustomEvent("wl:payment", {
          detail: { paymentId, deleted: true }
        }));
      })
      .catch(console.error);
  }

  function safelyHandleDeleteTransaction(data) {
    const transactionId = data.transaction_id || data.id;
    if (!transactionId) return;
    if (data.type === "payment") {
      window.WLDB.deletePaymentLocally(transactionId)
        .then(() => {
          window.dispatchEvent(new CustomEvent("wl:payment", {
            detail: { paymentId: transactionId, deleted: true }
          }));
        })
        .catch(console.error);
    } else {
      window.WLDB.deleteInvoiceLocally(transactionId)
        .then(() => {
          window.dispatchEvent(new CustomEvent("wl:ledger-entry", {
            detail: { transactionId, deleted: true }
          }));
        })
        .catch(console.error);
    }
  }

  async function handlePayment(payload) {
    const data = payload?.data || payload || {};
    const business = await window.WLDB.getActiveBusiness();
    if (data.business_prefix && business?.prefix && data.business_prefix !== business.prefix) return null;

    let clientId = data.client_id || null;
    let matchedClient = null;
    if (clientId) {
      matchedClient = await window.WLDB.getClient(clientId);
      if (!matchedClient) {
        await window.WLDB.pullSync();
        matchedClient = await window.WLDB.getClient(clientId);
      }
    }
    let matchScore = matchedClient ? 1 : 0;

    if (!matchedClient && data.client_name) {
      const match = await window.WLDB.fuzzyMatchClient(data.client_name, business?.id);
      matchedClient = match.score > 0.8 ? match.client : null;
      clientId = matchedClient?.id || null;
      matchScore = match.score;
    }

    const confidence = Number(data.confidence ?? 0);
    const status = confidence >= 0.85 && clientId ? "confirmed" : "pending_review";
    const payment = await window.WLDB.addPayment({
      business_id: business?.id,
      client_id: clientId,
      client_name: data.client_name || matchedClient?.name || "",
      amount: Number(data.amount) || 0,
      mode: data.mode || "unknown",
      recorded_at: Number(data.recorded_at) || Date.now(),
      source: data.source || "whatsapp_text",
      source_number: data.source_number || "",
      raw_input: data.raw_input || "",
      confidence,
      status,
      utr_number: data.utr_number || null,
      business_prefix: data.business_prefix || null,
      match_score: matchScore,
      skipPush: true
    });

    const amount = window.WLDB.formatCurrency(payment.amount, (await window.WLDB.getSettings()).currency_symbol);
    if (status === "confirmed") {
      window.WLNotify.success(`${amount} recorded`, matchedClient?.name || "Client matched");
    } else {
      window.WLNotify.warning("Payment needs review", `${amount} from ${data.client_name || "unknown client"}`);
    }

    window.dispatchEvent(new CustomEvent("wl:payment", {
      detail: { payment, client: matchedClient, status, reviewNeeded: status === "pending_review" }
    }));
    return payment;
  }

  async function handleTransaction(payload) {
    const data = payload?.data || payload || {};
    if (data.type === "payment") return handlePayment(data);
    if (data.type !== "goods") return null;

    const business = await window.WLDB.getActiveBusiness();
    if (data.business_prefix && business?.prefix && data.business_prefix !== business.prefix) return null;

    let clientId = data.client_id || null;
    let matchedClient = null;
    if (clientId) {
      matchedClient = await window.WLDB.getClient(clientId);
      if (!matchedClient) {
        await window.WLDB.pullSync();
        matchedClient = await window.WLDB.getClient(clientId);
      }
    }
    let matchScore = matchedClient ? 1 : 0;

    if (!matchedClient && data.client_name) {
      const match = await window.WLDB.fuzzyMatchClient(data.client_name, business?.id);
      matchedClient = match.score > 0.8 ? match.client : null;
      clientId = matchedClient?.id || null;
      matchScore = match.score;
    }

    const confidence = Number(data.confidence ?? 0);
    const status = data.status || (confidence >= 0.85 && clientId ? "confirmed" : "pending_review");
    const amount = window.WLDB.formatCurrency(Number(data.amount) || 0, (await window.WLDB.getSettings()).currency_symbol);

    if (status !== "confirmed" || !clientId) {
      window.WLNotify.warning("Goods entry needs review", `${amount} for ${data.client_name || "unknown client"}`);
      window.dispatchEvent(new CustomEvent("wl:ledger-entry", {
        detail: { transaction: data, client: matchedClient, status, reviewNeeded: true }
      }));
      return null;
    }

    const invoice = await window.WLDB.addInvoice({
      ...data,
      id: data.transaction_id || data.id,
      business_id: business?.id,
      client_id: clientId,
      client_name: data.client_name || matchedClient?.name || "",
      match_score: matchScore,
      status: "confirmed"
    });

    window.WLNotify.success("Goods recorded", `${amount} for ${matchedClient?.name || data.client_name}`);
    window.dispatchEvent(new CustomEvent("wl:ledger-entry", {
      detail: { type: "goods", transaction: data, invoice, client: matchedClient, status: "confirmed" }
    }));
    return invoice;
  }

  async function startSimulator() {
    setStatus("live", "Live");
    await window.WLDB.appendConnectionLog("Development SSE simulator running", "info");
    const tick = async () => {
      const summaries = await window.WLDB.computeClientSummaries();
      const candidates = summaries.filter((item) => item.balance > 0);
      if (!candidates.length) return;
      const summary = candidates[Math.floor(Math.random() * candidates.length)];
      const amountOptions = [3000, 4500, 6000, 8000, 12000, 15000, 25000];
      const sourceOptions = ["whatsapp_voice", "whatsapp_text", "whatsapp_image"];
      const modeOptions = ["upi", "cash", "neft", "rtgs", "unknown"];
      const confidence = Math.random() > 0.22 ? 0.88 + Math.random() * 0.1 : 0.62 + Math.random() * 0.2;
      const fuzzyName = Math.random() > 0.18
        ? summary.client.name
        : summary.client.name.replace("Store", "").replace("Merchants", "Merchant").trim();
      await handlePayment({
        type: "payment",
        data: {
          client_name: fuzzyName,
          client_id: Math.random() > 0.25 ? summary.client.id : null,
          amount: amountOptions[Math.floor(Math.random() * amountOptions.length)],
          mode: modeOptions[Math.floor(Math.random() * modeOptions.length)],
          recorded_at: Date.now(),
          source: sourceOptions[Math.floor(Math.random() * sourceOptions.length)],
          source_number: Math.random() > 0.5 ? "+919876500001" : "+919876500002",
          raw_input: `Auto demo: ${fuzzyName} paid amount by WhatsApp update`,
          confidence,
          utr_number: Math.random() > 0.52 ? `UPI${Math.floor(100000 + Math.random() * 899999)}` : null,
          business_prefix: "RAM"
        }
      });
    };
    simulatorTimer = window.setTimeout(async function run() {
      await tick();
      simulatorTimer = window.setTimeout(run, 30000);
    }, 6000);
  }

  async function testConnection(endpoint) {
    if (!endpoint) {
      await window.WLDB.appendConnectionLog("Simulator endpoint tested successfully", "success");
      return { ok: true, message: "Development simulator is available" };
    }
    return new Promise((resolve) => {
      let source;
      const timer = window.setTimeout(async () => {
        if (source) source.close();
        await window.WLDB.appendConnectionLog("SSE test timed out", "error");
        resolve({ ok: false, message: "Connection timed out" });
      }, 5000);
      try {
        source = new EventSource(endpoint);
      } catch (error) {
        window.clearTimeout(timer);
        resolve({ ok: false, message: error.message });
        return;
      }
      source.onopen = async () => {
        window.clearTimeout(timer);
        source.close();
        await window.WLDB.appendConnectionLog("SSE test connection succeeded", "success");
        resolve({ ok: true, message: "Connection opened" });
      };
      source.onerror = async () => {
        window.clearTimeout(timer);
        source.close();
        await window.WLDB.appendConnectionLog("SSE test connection failed", "error");
        resolve({ ok: false, message: "Connection failed" });
      };
    });
  }

  function setStatus(status, label) {
    window.dispatchEvent(new CustomEvent("wl:connection", { detail: { status, label } }));
    if (window.WLUI) window.WLUI.setConnectionStatus(status, label);
  }

  function isDevelopment() {
    return ["localhost", "127.0.0.1", ""].includes(window.location.hostname);
  }

  window.WLSSE = {
    start,
    stop,
    handlePayment,
    testConnection
  };
})();
