(function () {
  const state = {
    clientId: null,
    settings: null,
    business: null,
    ledger: null
  };

  document.addEventListener("DOMContentLoaded", initDetail);

  async function initDetail() {
    await window.WLDB.init();
    await window.WLUI.initShell("clients");
    window.WLExport.bindExportButtons();
    state.clientId = new URLSearchParams(window.location.search).get("id");
    bindEvents();
    await loadAndRender();
    await window.WLSSE.start();
  }

  function bindEvents() {
    document.addEventListener("click", async (event) => {
      if (event.target.closest("[data-send-reminder]")) sendReminder();
      if (event.target.closest("[data-record-payment]")) await openPaymentModal();
      if (event.target.closest("[data-export-statement]")) await window.WLExport.exportClientPdf(state.clientId);
      const invoice = event.target.closest("[data-invoice-toggle]");
      if (invoice) invoice.closest(".ledger-item").classList.toggle("is-expanded");
    });
    const refreshFromLedgerEvent = async (event) => {
      const clientId = event.detail?.payment?.client_id
        || event.detail?.invoice?.client_id
        || event.detail?.transaction?.client_id;
      if (clientId === state.clientId) {
        await loadAndRender();
        document.querySelectorAll(".ledger-item, .timeline-item").forEach((node, index) => {
          if (index < 2) node.classList.add("row-flash");
        });
      }
    };
    window.addEventListener("wl:payment", refreshFromLedgerEvent);
    window.addEventListener("wl:ledger-entry", refreshFromLedgerEvent);
  }

  async function loadAndRender() {
    state.settings = await window.WLDB.getSettings();
    state.business = await window.WLDB.getActiveBusiness();
    if (!state.clientId) {
      renderMissing();
      return;
    }
    state.ledger = await window.WLDB.getClientLedger(state.clientId);
    if (!state.ledger.client) {
      renderMissing();
      return;
    }
    renderHero();
    renderInvoices();
    renderTimeline();
  }

  function renderMissing() {
    const main = document.querySelector("[data-detail-page]");
    main.innerHTML = `<div class="empty-state">Client ledger not found.</div>`;
  }

  function renderHero() {
    const { client, summary } = state.ledger;
    document.querySelector("[data-client-title]").textContent = client.name;
    document.querySelector("[data-client-phone]").textContent = client.phone;
    document.querySelector("[data-client-limit]").textContent = `Credit ${money(client.credit_limit)}`;
    document.querySelector("[data-client-cycle]").textContent = `${client.payment_cycle_days} day cycle`;
    document.querySelector("[data-client-balance]").textContent = money(summary.balance);
    document.querySelector("[data-client-status]").innerHTML = `<span class="status-badge ${window.WLDB.statusClass(summary.status)}">${window.WLDB.statusLabel(summary.status, summary.overdueDays)}</span>`;
    const utilization = client.credit_limit ? Math.min(100, Math.round((summary.balance / client.credit_limit) * 100)) : 0;
    document.querySelector("[data-utilization-bar]").style.setProperty("--value", `${utilization}%`);
    document.querySelector("[data-utilization-copy]").textContent = `${utilization}% of limit used`;
  }

  function renderInvoices() {
    const list = document.querySelector("[data-invoice-list]");
    if (!state.ledger.invoices.length) {
      list.innerHTML = `<div class="empty-state">No invoices recorded for this client.</div>`;
      return;
    }
    list.innerHTML = [...state.ledger.invoices]
      .sort((a, b) => Number(b.created_at) - Number(a.created_at))
      .map(invoiceCard)
      .join("");
  }

  function invoiceCard(invoice) {
    const payments = state.ledger.payments.filter((payment) => payment.invoice_id === invoice.id && payment.status === "confirmed");
    return `
      <article class="ledger-item" data-invoice-id="${invoice.id}">
        <button class="invoice-button" type="button" data-invoice-toggle>
          <div class="invoice-main">
            <strong>Invoice ${invoice.id.slice(0, 8).toUpperCase()}</strong>
            <div class="invoice-sub">
              <span>Raised ${window.WLDB.formatDateContext(invoice.created_at)}</span>
              <span>Due ${window.WLDB.formatDateContext(invoice.due_date)}</span>
              <span class="status-badge ${window.WLDB.statusClass(invoice.status === "overdue" ? "overdue" : invoice.status)}">${window.WLDB.statusLabel(invoice.status, Math.abs(invoice.dueDays || 0))}</span>
            </div>
          </div>
          <div class="invoice-amounts">
            <strong>${money(invoice.balance)}</strong>
            <span>${money(invoice.paid)} paid of ${money(invoice.amount)}</span>
          </div>
        </button>
        <div class="invoice-payments">
          ${payments.length ? payments.map((payment) => `
            <div class="invoice-payment-row">
              <span>${window.WLDB.formatDateContext(payment.recorded_at)} · ${escape(payment.mode)}</span>
              <strong class="amount">${money(payment.amount)}</strong>
            </div>`).join("") : `<div class="invoice-payment-row"><span>No payments against this invoice.</span></div>`}
        </div>
      </article>`;
  }

  function renderTimeline() {
    const list = document.querySelector("[data-payment-timeline]");
    if (!state.ledger.payments.length) {
      list.innerHTML = `<div class="empty-state">No payment history yet.</div>`;
      return;
    }
    list.innerHTML = state.ledger.payments
      .sort((a, b) => Number(b.recorded_at) - Number(a.recorded_at))
      .map((payment) => `
        <article class="timeline-item" data-source="${payment.source}">
          <div class="timeline-head">
            <strong>${money(payment.amount)}</strong>
            <span class="confidence-badge ${window.WLDB.confidenceClass(payment.confidence)}">${Math.round(Number(payment.confidence || 0) * 100)}%</span>
          </div>
          <div class="timeline-meta">
            ${window.WLDB.formatDateContext(payment.recorded_at)} · ${escape(payment.mode)} · ${window.WLDB.sourceLabel(payment.source)} · ${escape(payment.source_number || "manual")}
          </div>
          <p class="timeline-raw">${escape(payment.raw_input || payment.notes || "Manual Entry")}</p>
        </article>`)
      .join("");
  }

  async function openPaymentModal() {
    const modal = ensurePaymentModal();
    const form = modal.querySelector("form");
    form.reset();
    form.querySelector("[name='date']").value = new Date().toISOString().slice(0, 10);
    const invoiceSelect = form.querySelector("[name='invoice_id']");
    const openInvoices = await window.WLDB.getOpenInvoicesForClient(state.clientId);
    invoiceSelect.innerHTML = openInvoices.length
      ? openInvoices.map((invoice) => `<option value="${invoice.id}">${money(invoice.balance)} due ${window.WLDB.formatDateContext(invoice.due_date)}</option>`).join("")
      : `<option value="">No open invoice</option>`;
    window.WLUI.openModal(modal);
  }

  function ensurePaymentModal() {
    let modal = document.getElementById("recordPaymentModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "recordPaymentModal";
    modal.className = "modal-backdrop";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h2 class="modal-title">Record Payment</h2>
          <span class="source-badge">Manual Entry</span>
          <button class="icon-btn" type="button" data-close-modal aria-label="Close payment modal">×</button>
        </div>
        <form class="modal-body form-grid">
          <div class="field">
            <label>Amount</label>
            <input class="field-control" name="amount" type="number" min="1" step="1" required>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Payment mode</label>
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
            <label>Invoice to apply to</label>
            <select class="field-control" name="invoice_id"></select>
          </div>
          <div class="field">
            <label>Notes</label>
            <textarea class="field-control" name="notes" rows="3">Manual Entry</textarea>
          </div>
        </form>
        <div class="modal-foot">
          <button class="btn btn-ghost" type="button" data-close-modal>Cancel</button>
          <button class="btn btn-primary" type="button" data-save-detail-payment>Save Payment</button>
        </div>
      </div>`;
    document.body.append(modal);
    modal.querySelector("[data-save-detail-payment]").addEventListener("click", savePayment);
    return modal;
  }

  async function savePayment() {
    const modal = document.getElementById("recordPaymentModal");
    const form = modal.querySelector("form");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const payment = await window.WLDB.addPayment({
      client_id: state.clientId,
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
    window.WLNotify.success("Payment recorded", money(payment.amount));
    await loadAndRender();
  }

  function sendReminder() {
    const { client, summary } = state.ledger;
    const phone = client.phone.replace(/\D/g, "");
    const message = encodeURIComponent(`Hello ${client.name}, this is ${state.business.name}. Your outstanding balance is ${money(summary.balance)}. Please clear it at the earliest.`);
    window.open(`https://wa.me/${phone}?text=${message}`, "_blank", "noopener");
    window.WLNotify.info("Reminder ready", client.name);
  }

  function money(value) {
    return window.WLDB.formatCurrency(value, state.settings?.currency_symbol || "₹");
  }

  function escape(value) {
    return window.WLUI.escapeHtml(value);
  }
})();
