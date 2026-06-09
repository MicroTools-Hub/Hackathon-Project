(function () {
  const state = {
    settings: null,
    business: null,
    summaries: [],
    payments: [],
    pending: [],
    metrics: null,
    quickClientId: null,
    editPaymentId: null
  };

  document.addEventListener("DOMContentLoaded", initDashboard);

  async function initDashboard() {
    try {
      await window.WLDB.init();
    } catch (e) {
      console.error("[Dashboard] WLDB.init failed:", e);
    }
    try {
      await window.WLUI.initShell("dashboard");
    } catch (e) {
      console.error("[Dashboard] WLUI.initShell failed:", e);
    }
    try {
      if (window.WLExport && window.WLExport.bindExportButtons) {
        window.WLExport.bindExportButtons();
      }
    } catch (e) {}
    try {
      bindDashboardEvents();
    } catch (e) {}
    try {
      await renderDashboard();
    } catch (e) {
      console.error("[Dashboard] renderDashboard failed:", e);
    }
    try {
      if (window.WLSSE && window.WLSSE.start) {
        await window.WLSSE.start();
      }
    } catch (e) {}
  }

  function bindDashboardEvents() {
    document.addEventListener("click", handleClick);
    const refreshFromLedgerEvent = async (event) => {
      await renderDashboard();
      const clientId = event.detail?.payment?.client_id
        || event.detail?.invoice?.client_id
        || event.detail?.transaction?.client_id;
      if (clientId) flashClientRow(clientId);
    };
    window.addEventListener("wl:payment", refreshFromLedgerEvent);
    window.addEventListener("wl:ledger-entry", refreshFromLedgerEvent);
    window.addEventListener("wl:sync-completed", async () => {
      await renderDashboard();
    });
  }

  async function renderDashboard() {
    try {
      state.settings = await window.WLDB.getSettings();
    } catch (e) {
      console.error("[Dashboard] getSettings failed:", e);
    }
    try {
      state.business = await window.WLDB.getActiveBusiness();
    } catch (e) {
      console.error("[Dashboard] getActiveBusiness failed:", e);
    }
    try {
      state.summaries = await window.WLDB.computeClientSummaries();
    } catch (e) {
      console.error("[Dashboard] computeClientSummaries failed:", e);
    }
    try {
      state.payments = await window.WLDB.getPayments();
    } catch (e) {
      console.error("[Dashboard] getPayments failed:", e);
    }
    
    let pendingPayments = [];
    try {
      pendingPayments = state.payments
        .filter((p) => p.status === "pending_review")
        .map(p => ({ ...p, type: "payment" }));
    } catch (e) {}

    let pendingInvoices = [];
    try {
      pendingInvoices = (await window.WLDB.getPendingInvoices())
        .map(i => ({ ...i, type: "goods" }));
    } catch (e) {
      console.error("[Dashboard] getPendingInvoices failed:", e);
    }

    try {
      state.pending = [...pendingPayments, ...pendingInvoices]
        .sort((a, b) => Number(b.recorded_at || b.created_at || 0) - Number(a.recorded_at || a.created_at || 0));
    } catch (e) {}

    try {
      state.metrics = await window.WLDB.computeMetrics();
    } catch (e) {
      console.error("[Dashboard] computeMetrics failed:", e);
      state.metrics = { totalOutstanding: 0, overdue: 0, dueThisWeek: 0, collectedThisMonth: 0 };
    }

    try {
      renderMetrics();
    } catch (e) {
      console.error("[Dashboard] renderMetrics failed:", e);
    }
    try {
      renderClientTable();
    } catch (e) {
      console.error("[Dashboard] renderClientTable failed:", e);
    }
    try {
      renderLiveFeed();
    } catch (e) {
      console.error("[Dashboard] renderLiveFeed failed:", e);
    }
    try {
      renderPendingReview();
    } catch (e) {
      console.error("[Dashboard] renderPendingReview failed:", e);
    }
  }

  function renderMetrics() {
    animateAmount("[data-metric='outstanding']", state.metrics.totalOutstanding);
    animateAmount("[data-metric='overdue']", state.metrics.overdue);
    animateAmount("[data-metric='week']", state.metrics.dueThisWeek);
    animateAmount("[data-metric='month']", state.metrics.collectedThisMonth);
    const counts = {
      outstanding: state.summaries.filter((item) => item.balance > 0).length,
      overdue: state.summaries.filter((item) => item.status === "overdue").length,
      week: state.summaries.filter((item) => item.dueThisWeekAmount > 0).length,
      month: state.payments.filter((payment) => payment.status === "confirmed").length
    };
    Object.entries(counts).forEach(([key, value]) => {
      const node = document.querySelector(`[data-metric-count='${key}']`);
      if (node) node.textContent = `${value} ${value === 1 ? "entry" : "entries"}`;
    });
  }

  function animateAmount(selector, target) {
    const node = document.querySelector(selector);
    if (!node) return;
    const from = Number(node.dataset.value || 0);
    const to = Number(target || 0);
    const start = performance.now();
    node.dataset.value = String(to);
    const duration = 800;
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = from + ((to - from) * eased);
      node.textContent = window.WLDB.formatCurrency(value, state.settings.currency_symbol);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function sortedSummaries() {
    const rank = { overdue: 0, due_soon: 1, partial: 2, active: 3, paid: 4 };
    return [...state.summaries].sort((a, b) => (rank[a.status] - rank[b.status]) || (b.balance - a.balance));
  }

  function renderClientTable() {
    const tbody = document.querySelector("[data-client-table-body]");
    const mobileList = document.querySelector("[data-client-mobile-list]");
    const rows = sortedSummaries();
    if (tbody) {
      tbody.innerHTML = rows.map((summary) => clientTableRow(summary)).join("");
    }
    if (mobileList) {
      mobileList.innerHTML = rows.map((summary) => clientMobileCard(summary)).join("");
    }
  }

  function clientTableRow(summary) {
    const status = window.WLDB.statusLabel(summary.status, summary.overdueDays);
    const action = actionFor(summary);
    return `
      <tr data-client-id="${summary.client.id}">
        <td>
          <a class="client-name-cell" href="client-detail.html?id=${summary.client.id}">
            <strong>${escape(summary.client.name)}</strong>
            <span>${escape(summary.client.phone)}</span>
          </a>
        </td>
        <td class="amount">${money(summary.balance)}</td>
        <td>
          <div class="paid-progress">
            <div class="progress" aria-label="${summary.paidPercent}% paid"><span style="--value:${summary.paidPercent}%"></span></div>
            <span class="mono">${summary.paidPercent}%</span>
          </div>
        </td>
        <td><span class="status-badge ${window.WLDB.statusClass(summary.status)}">${escape(status)}</span></td>
        <td>${summary.nextDue ? window.WLDB.formatDateContext(summary.nextDue) : "Cleared"}</td>
        <td><span class="due-text">${dueCopy(summary)}</span></td>
        <td><button class="btn ${action.className}" type="button" data-client-action="${action.type}" data-client-id="${summary.client.id}">${action.label}</button></td>
      </tr>`;
  }

  function clientMobileCard(summary) {
    const status = window.WLDB.statusLabel(summary.status, summary.overdueDays);
    const action = actionFor(summary);
    return `
      <article class="client-row-card" data-client-id="${summary.client.id}">
        <div class="client-row-top">
          <div class="client-name-cell">
            <strong>${escape(summary.client.name)}</strong>
            <span>${escape(summary.client.phone)}</span>
          </div>
          <span class="status-badge ${window.WLDB.statusClass(summary.status)}">${escape(status)}</span>
        </div>
        <div class="client-row-meta">
          <span class="amount">${money(summary.balance)}</span>
          <span>${summary.nextDue ? window.WLDB.formatDateContext(summary.nextDue) : "Cleared"}</span>
        </div>
        <div class="progress" aria-label="${summary.paidPercent}% paid"><span style="--value:${summary.paidPercent}%"></span></div>
        <button class="btn ${action.className}" type="button" data-client-action="${action.type}" data-client-id="${summary.client.id}">${action.label}</button>
      </article>`;
  }

  function actionFor(summary) {
    if (summary.status === "overdue") return { type: "reminder", label: "Send Reminder", className: "btn-danger" };
    if (summary.status === "partial") return { type: "record", label: "Record Payment", className: "btn-primary" };
    return { type: "view", label: "View Ledger", className: "btn-blue" };
  }

  function dueCopy(summary) {
    if (summary.status === "paid") return "<span>Settled</span><small>No balance</small>";
    if (summary.status === "overdue") return `<span>${summary.overdueDays} days late</span><small>Action needed</small>`;
    if (summary.remainingDays === 0) return "<span>Due today</span><small>Collect today</small>";
    return `<span>${summary.remainingDays ?? "-"} days left</span><small>${summary.status === "partial" ? "Partial paid" : "Open invoice"}</small>`;
  }

  function renderLiveFeed() {
    const list = document.querySelector("[data-live-feed]");
    if (!list) return;
    const feed = state.payments.slice(0, 10);
    if (!feed.length) {
      list.innerHTML = `<div class="empty-state">No payment activity yet.</div>`;
      return;
    }
    list.innerHTML = feed.map((payment) => {
      const client = state.summaries.find((item) => item.client.id === payment.client_id)?.client;
      const tone = payment.status === "pending_review" ? "amber" : payment.confidence < 0.7 ? "red" : "green";
      return `
        <article class="feed-entry" data-tone="${tone}">
          <div class="feed-entry-head">
            <strong>${escape(client?.name || payment.client_name || "Unmatched client")}</strong>
            <span class="amount">${money(payment.amount)}</span>
          </div>
          <div class="feed-meta">
            <span>${escape(payment.mode)}</span>
            <span>${window.WLDB.timeAgo(payment.recorded_at)}</span>
            <span class="source-badge">${window.WLDB.sourceLabel(payment.source)}</span>
            <span class="confidence-badge ${window.WLDB.confidenceClass(payment.confidence)}">${Math.round(Number(payment.confidence || 0) * 100)}%</span>
          </div>
        </article>`;
    }).join("");
  }

  function renderPendingReview() {
    const grid = document.querySelector("[data-pending-review]");
    const section = document.querySelector("[data-pending-section]");
    if (!grid || !section) return;
    section.hidden = state.pending.length === 0;
    if (!state.pending.length) {
      grid.innerHTML = "";
      return;
    }
    grid.innerHTML = state.pending.map((payment) => {
      const client = state.summaries.find((item) => item.client.id === payment.client_id)?.client;
      const isPayment = payment.type === "payment";
      const detailLabel = isPayment ? "Mode" : "Credit Days";
      const detailValue = isPayment ? escape(payment.mode || "unknown") : (payment.credit_days != null ? payment.credit_days : "Not set");
      const typeLabel = isPayment ? "Payment" : "Goods";
      const typeColor = isPayment ? "#27ae60" : "#d4900a";
      return `
        <article class="review-card" data-payment-id="${payment.id}">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
            <p class="review-raw" style="margin: 0; flex: 1;">${escape(payment.raw_input || "No raw message captured")}</p>
            <span style="font-size: 0.72rem; font-family: var(--mono); padding: 0.15rem 0.4rem; border-radius: var(--radius-sm); background: ${typeColor}; color: #0d0f0e; font-weight: bold; margin-left: 0.5rem; text-transform: uppercase;">${typeLabel}</span>
          </div>
          <div class="review-extracted">
            <span>Client <strong>${escape(client?.name || payment.client_name || "Unmatched")}</strong></span>
            <span>Amount <strong>${money(payment.amount)}</strong></span>
            <span>${detailLabel} <strong>${detailValue}</strong></span>
            <span>Confidence <strong>${Math.round(Number(payment.confidence || 0) * 100)}%</strong></span>
          </div>
          <div class="review-actions">
            <button class="btn btn-green" type="button" data-review-action="confirm" data-payment-id="${payment.id}">Confirm</button>
            <button class="btn btn-primary" type="button" data-review-action="edit" data-payment-id="${payment.id}">Edit & Confirm</button>
            <button class="btn btn-danger" type="button" data-review-action="discard" data-payment-id="${payment.id}">Discard</button>
          </div>
        </article>`;
    }).join("");
  }

  async function handleClick(event) {
    const clientAction = event.target.closest("[data-client-action]");
    if (clientAction) {
      const summary = state.summaries.find((item) => item.client.id === clientAction.dataset.clientId);
      if (!summary) return;
      if (clientAction.dataset.clientAction === "reminder") sendReminder(summary);
      if (clientAction.dataset.clientAction === "record") await openPaymentModal(summary.client.id);
      if (clientAction.dataset.clientAction === "view") window.location.href = `client-detail.html?id=${summary.client.id}`;
      return;
    }

    const reviewAction = event.target.closest("[data-review-action]");
    if (reviewAction) {
      const payment = state.pending.find((item) => String(item.id) === reviewAction.dataset.paymentId);
      if (!payment) return;
      if (reviewAction.dataset.reviewAction === "confirm") await confirmReviewPayment(payment);
      if (reviewAction.dataset.reviewAction === "edit") await openReviewModal(payment);
      if (reviewAction.dataset.reviewAction === "discard") await discardReviewPayment(payment);
    }
  }

  function sendReminder(summary) {
    const phone = summary.client.phone.replace(/\D/g, "");
    const message = encodeURIComponent(`Hello ${summary.client.name}, this is ${state.business.name}. Your outstanding balance is ${money(summary.balance)}. Please clear it at the earliest.`);
    window.open(`https://wa.me/${phone}?text=${message}`, "_blank", "noopener");
    window.WLNotify.info("Reminder ready", summary.client.name);
  }

  async function confirmReviewPayment(payment) {
    if (!payment.client_id) {
      await openReviewModal(payment);
      return;
    }
    if (payment.type === "goods") {
      if (payment.credit_days == null || payment.credit_days === "") {
        await openReviewModal(payment);
        return;
      }
      await window.WLDB.confirmInvoice(payment.id);
      window.WLNotify.success("Goods entry confirmed", money(payment.amount));
    } else {
      await window.WLDB.confirmPayment(payment.id);
      window.WLNotify.success("Payment confirmed", money(payment.amount));
    }
    await renderDashboard();
    flashClientRow(payment.client_id);
  }

  async function discardReviewPayment(payment) {
    try {
      if (payment.type === "goods") {
        await window.WLDB.discardInvoice(payment.id);
        window.WLNotify.info("Goods entry discarded", money(payment.amount));
      } else {
        await window.WLDB.discardPayment(payment.id);
        window.WLNotify.info("Payment discarded", money(payment.amount));
      }
      await renderDashboard();
    } catch (error) {
      console.error("Failed to discard transaction:", error);
      window.WLNotify.error("Failed to discard transaction", error.message);
    }
  }

  async function openPaymentModal(clientId) {
    state.quickClientId = clientId;
    const modal = ensurePaymentModal();
    const form = modal.querySelector("form");
    form.reset();
    modal.querySelector("[name='date']").value = new Date().toISOString().slice(0, 10);
    await populateInvoiceSelect(modal.querySelector("[name='invoice_id']"), clientId);
    window.WLUI.openModal(modal);
  }

  function ensurePaymentModal() {
    let modal = document.getElementById("quickPaymentModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "quickPaymentModal";
    modal.className = "modal-backdrop";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h2 class="modal-title">Record Payment</h2>
          <button class="icon-btn" type="button" data-close-modal aria-label="Close payment modal">×</button>
        </div>
        <form class="modal-body quick-modal-grid" data-quick-payment-form>
          <div class="field">
            <label>Amount</label>
            <input class="field-control" name="amount" type="number" min="1" step="1" required>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Mode</label>
              <select class="field-control" name="mode">
                <option value="upi">UPI</option>
                <option value="cash">Cash</option>
                <option value="neft">NEFT</option>
                <option value="rtgs">RTGS</option>
                <option value="cheque">Cheque</option>
              </select>
            </div>
            <div class="field">
              <label>Date</label>
              <input class="field-control" name="date" type="date" required>
            </div>
          </div>
          <div class="field">
            <label>Invoice</label>
            <select class="field-control" name="invoice_id"></select>
          </div>
          <div class="field">
            <label>Notes</label>
            <textarea class="field-control" name="notes" rows="3">Manual Entry</textarea>
          </div>
        </form>
        <div class="modal-foot">
          <button class="btn btn-ghost" type="button" data-close-modal>Cancel</button>
          <button class="btn btn-primary" type="button" data-save-quick-payment>Save Payment</button>
        </div>
      </div>`;
    document.body.append(modal);
    modal.querySelector("[data-save-quick-payment]").addEventListener("click", saveQuickPayment);
    return modal;
  }

  async function populateInvoiceSelect(select, clientId) {
    const openInvoices = await window.WLDB.getOpenInvoicesForClient(clientId);
    select.innerHTML = openInvoices.length
      ? openInvoices.map((invoice) => `<option value="${invoice.id}">${money(invoice.balance)} due ${window.WLDB.formatDateContext(invoice.due_date)}</option>`).join("")
      : `<option value="">No open invoice</option>`;
  }

  async function saveQuickPayment() {
    const modal = document.getElementById("quickPaymentModal");
    const form = modal.querySelector("form");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    await window.WLDB.addPayment({
      client_id: state.quickClientId,
      invoice_id: data.get("invoice_id") || null,
      amount: data.get("amount"),
      mode: data.get("mode"),
      recorded_at: new Date(`${data.get("date")}T12:00:00`).getTime(),
      source: "manual",
      source_number: "manual",
      raw_input: data.get("notes") || "Manual Entry",
      notes: data.get("notes") || "Manual Entry",
      confidence: 1,
      status: "confirmed"
    });
    window.WLUI.closeModal(modal);
    window.WLNotify.success("Payment recorded", money(Number(data.get("amount"))));
    await renderDashboard();
    flashClientRow(state.quickClientId);
  }

  async function openReviewModal(payment) {
    state.editPaymentId = payment.id;
    state.editPaymentType = payment.type;
    const modal = ensureReviewModal();
    const isPayment = payment.type === "payment";

    const modeField = modal.querySelector("[data-field-mode]");
    const invoiceField = modal.querySelector("[data-field-invoice]");
    const creditDaysField = modal.querySelector("[data-field-credit-days]");

    if (isPayment) {
      if (modeField) modeField.style.display = "";
      if (invoiceField) invoiceField.style.display = "";
      if (creditDaysField) creditDaysField.style.display = "none";
      modal.querySelector(".modal-title").textContent = "Edit Review Payment";
      modal.querySelector("[data-save-review-payment]").textContent = "Confirm Payment";
    } else {
      if (modeField) modeField.style.display = "none";
      if (invoiceField) invoiceField.style.display = "none";
      if (creditDaysField) creditDaysField.style.display = "";
      modal.querySelector(".modal-title").textContent = "Edit Review Goods Entry";
      modal.querySelector("[data-save-review-payment]").textContent = "Confirm Goods Entry";
    }

    let clients = await window.WLDB.getClients();
    
    // Ensure the client for this transaction is in the clients list
    const hasTransactionClient = clients.some(c => c.id === payment.client_id || (payment.client_name && c.name.toLowerCase() === payment.client_name.toLowerCase()));
    
    if (!hasTransactionClient && (payment.client_id || payment.client_name)) {
      clients.push({
        id: payment.client_id || `temp-${Date.now()}`,
        name: payment.client_name || "Unknown Client"
      });
    }

    state.reviewClients = clients;

    const clientSelect = modal.querySelector("[name='client_id']");
    if (clients.length) {
      clientSelect.innerHTML = clients.map((client) => `<option value="${client.id}">${escape(client.name)}</option>`).join("");
      clientSelect.value = payment.client_id || clients[clients.length - 1]?.id || "";
    } else {
      clientSelect.innerHTML = `<option value="">No clients found. Add a client first.</option>`;
      clientSelect.value = "";
    }
    modal.querySelector("[name='amount']").value = payment.amount;

    if (isPayment) {
      modal.querySelector("[name='mode']").value = payment.mode || "unknown";
      await populateInvoiceSelect(modal.querySelector("[name='invoice_id']"), clientSelect.value);
      clientSelect.onchange = async () => populateInvoiceSelect(modal.querySelector("[name='invoice_id']"), clientSelect.value);
    } else {
      modal.querySelector("[name='credit_days']").value = payment.credit_days != null ? payment.credit_days : "";
      clientSelect.onchange = null;
    }

    modal.querySelector("[name='date']").value = new Date(payment.recorded_at || Date.now()).toISOString().slice(0, 10);
    modal.querySelector("[name='raw_input']").value = payment.raw_input || "";
    
    window.WLUI.openModal(modal);
  }

  function ensureReviewModal() {
    let modal = document.getElementById("reviewPaymentModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "reviewPaymentModal";
    modal.className = "modal-backdrop";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h2 class="modal-title">Edit Review Payment</h2>
          <button class="icon-btn" type="button" data-close-modal aria-label="Close review modal">×</button>
        </div>
        <form class="modal-body form-grid" data-review-payment-form>
          <div class="field">
            <label>Client</label>
            <select class="field-control" name="client_id" required></select>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Amount</label>
              <input class="field-control" name="amount" type="number" min="1" step="1" required>
            </div>
            <div class="field" data-field-mode>
              <label>Mode</label>
              <select class="field-control" name="mode">
                <option value="upi">UPI</option>
                <option value="cash">Cash</option>
                <option value="neft">NEFT</option>
                <option value="rtgs">RTGS</option>
                <option value="cheque">Cheque</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>
            <div class="field" data-field-credit-days style="display: none;">
              <label>Credit Period (Days)</label>
              <input class="field-control" name="credit_days" type="number" min="1" step="1" placeholder="e.g. 30">
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Date</label>
              <input class="field-control" name="date" type="date" required>
            </div>
            <div class="field" data-field-invoice>
              <label>Invoice</label>
              <select class="field-control" name="invoice_id"></select>
            </div>
          </div>
          <div class="field">
            <label>Raw input</label>
            <textarea class="field-control" name="raw_input" rows="3"></textarea>
          </div>
        </form>
        <div class="modal-foot">
          <button class="btn btn-ghost" type="button" data-close-modal>Cancel</button>
          <button class="btn btn-primary" type="button" data-save-review-payment>Confirm Payment</button>
        </div>
      </div>`;
    document.body.append(modal);
    modal.querySelector("[data-save-review-payment]").addEventListener("click", saveReviewPayment);
    return modal;
  }

  async function saveReviewPayment() {
    const modal = document.getElementById("reviewPaymentModal");
    const form = modal.querySelector("form");
    if (!form.reportValidity()) return;
    const data = new FormData(form);

    let clientId = data.get("client_id");
    if (clientId && clientId.startsWith("temp-")) {
      const tempClient = state.reviewClients?.find(c => c.id === clientId);
      if (tempClient) {
        try {
          const newClient = await window.WLDB.addClient({
            name: tempClient.name,
            phone: ""
          });
          clientId = newClient.id;
        } catch (err) {
          console.error("Failed to dynamically register client on review confirmation:", err);
          window.WLNotify.error("Failed to register client", err.message);
          return;
        }
      }
    }

    let result;
    if (state.editPaymentType === "goods") {
      result = await window.WLDB.confirmInvoice(state.editPaymentId, {
        client_id: clientId,
        amount: data.get("amount"),
        credit_days: data.get("credit_days") ? Number(data.get("credit_days")) : null,
        recorded_at: new Date(`${data.get("date")}T12:00:00`).getTime(),
        raw_input: data.get("raw_input"),
        confidence: 1
      });
      window.WLUI.closeModal(modal);
      window.WLNotify.success("Goods entry confirmed", money(result.amount));
    } else {
      result = await window.WLDB.confirmPayment(state.editPaymentId, {
        client_id: clientId,
        invoice_id: data.get("invoice_id") || null,
        amount: data.get("amount"),
        mode: data.get("mode"),
        recorded_at: new Date(`${data.get("date")}T12:00:00`).getTime(),
        raw_input: data.get("raw_input"),
        confidence: 1
      });
      window.WLUI.closeModal(modal);
      window.WLNotify.success("Payment confirmed", money(result.amount));
    }
    await renderDashboard();
    flashClientRow(result.client_id);
  }

  function flashClientRow(clientId) {
    document.querySelectorAll(`[data-client-id='${clientId}']`).forEach((node) => {
      node.classList.remove("row-flash");
      void node.offsetWidth;
      node.classList.add("row-flash");
    });
  }

  function money(value) {
    return window.WLDB.formatCurrency(value, state.settings?.currency_symbol || "₹");
  }

  function escape(value) {
    return window.WLUI.escapeHtml(value);
  }
})();
