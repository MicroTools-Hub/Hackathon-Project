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
    await window.WLDB.init();
    await window.WLUI.initShell("dashboard");
    window.WLExport.bindExportButtons();
    bindDashboardEvents();
    await renderDashboard();
    await window.WLSSE.start();
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
  }

  async function renderDashboard() {
    state.settings = await window.WLDB.getSettings();
    state.business = await window.WLDB.getActiveBusiness();
    state.summaries = await window.WLDB.computeClientSummaries();
    state.payments = await window.WLDB.getPayments();
    state.pending = state.payments.filter((payment) => payment.status === "pending_review");
    state.metrics = await window.WLDB.computeMetrics();
    renderMetrics();
    renderClientTable();
    renderLiveFeed();
    renderPendingReview();
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
      return `
        <article class="review-card" data-payment-id="${payment.id}">
          <p class="review-raw">${escape(payment.raw_input || "No raw message captured")}</p>
          <div class="review-extracted">
            <span>Client <strong>${escape(client?.name || payment.client_name || "Unmatched")}</strong></span>
            <span>Amount <strong>${money(payment.amount)}</strong></span>
            <span>Mode <strong>${escape(payment.mode)}</strong></span>
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
      const payment = state.pending.find((item) => item.id === reviewAction.dataset.paymentId);
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
    await window.WLDB.confirmPayment(payment.id);
    window.WLNotify.success("Payment confirmed", money(payment.amount));
    await renderDashboard();
    flashClientRow(payment.client_id);
  }

  async function discardReviewPayment(payment) {
    await window.WLDB.discardPayment(payment.id);
    window.WLNotify.info("Payment discarded", money(payment.amount));
    await renderDashboard();
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
    const modal = ensureReviewModal();
    const clients = await window.WLDB.getClients();
    const clientSelect = modal.querySelector("[name='client_id']");
    clientSelect.innerHTML = clients.map((client) => `<option value="${client.id}">${escape(client.name)}</option>`).join("");
    clientSelect.value = payment.client_id || clients[0]?.id || "";
    modal.querySelector("[name='amount']").value = payment.amount;
    modal.querySelector("[name='mode']").value = payment.mode;
    modal.querySelector("[name='date']").value = new Date(payment.recorded_at || Date.now()).toISOString().slice(0, 10);
    modal.querySelector("[name='raw_input']").value = payment.raw_input || "";
    await populateInvoiceSelect(modal.querySelector("[name='invoice_id']"), clientSelect.value);
    clientSelect.onchange = async () => populateInvoiceSelect(modal.querySelector("[name='invoice_id']"), clientSelect.value);
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
            <div class="field">
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
          </div>
          <div class="field-row">
            <div class="field">
              <label>Date</label>
              <input class="field-control" name="date" type="date" required>
            </div>
            <div class="field">
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
    const payment = await window.WLDB.confirmPayment(state.editPaymentId, {
      client_id: data.get("client_id"),
      invoice_id: data.get("invoice_id") || null,
      amount: data.get("amount"),
      mode: data.get("mode"),
      recorded_at: new Date(`${data.get("date")}T12:00:00`).getTime(),
      raw_input: data.get("raw_input"),
      confidence: 1
    });
    window.WLUI.closeModal(modal);
    window.WLNotify.success("Payment confirmed", money(payment.amount));
    await renderDashboard();
    flashClientRow(payment.client_id);
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
