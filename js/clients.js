(function () {
  const state = {
    settings: null,
    business: null,
    summaries: [],
    filter: "all",
    search: "",
    sort: "amount"
  };

  document.addEventListener("DOMContentLoaded", initClients);

  async function initClients() {
    await window.WLDB.init();
    await window.WLUI.initShell("clients");
    window.WLExport.bindExportButtons();
    bindEvents();
    await loadAndRender();
    await window.WLSSE.start();
  }

  function bindEvents() {
    document.querySelector("[data-client-search]")?.addEventListener("input", (event) => {
      state.search = event.target.value.trim().toLowerCase();
      renderClients();
    });
    document.querySelector("[data-client-sort]")?.addEventListener("change", (event) => {
      state.sort = event.target.value;
      renderClients();
    });
    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
        renderClients();
      });
    });
    document.querySelector("[data-add-client]")?.addEventListener("click", openAddClientModal);
    document.querySelector("[data-save-client]")?.addEventListener("click", saveClient);
    document.addEventListener("click", handleCardAction);
    const refreshFromLedgerEvent = async () => {
      await loadAndRender();
    };
    window.addEventListener("wl:payment", refreshFromLedgerEvent);
    window.addEventListener("wl:ledger-entry", refreshFromLedgerEvent);
    window.addEventListener("wl:sync-completed", refreshFromLedgerEvent);
  }

  async function loadAndRender() {
    state.settings = await window.WLDB.getSettings();
    state.business = await window.WLDB.getActiveBusiness();
    state.summaries = await window.WLDB.computeClientSummaries();
    renderClients();
  }

  function filteredSummaries() {
    const filterMap = {
      all: () => true,
      overdue: (item) => item.status === "overdue",
      due_soon: (item) => item.status === "due_soon",
      paid: (item) => item.status === "paid",
      partial: (item) => item.status === "partial"
    };
    const matcher = filterMap[state.filter] || filterMap.all;
    return state.summaries
      .filter(matcher)
      .filter((summary) => {
        if (!state.search) return true;
        return `${summary.client.name} ${summary.client.phone}`.toLowerCase().includes(state.search);
      })
      .sort(sorter);
  }

  function sorter(a, b) {
    if (state.sort === "name") return a.client.name.localeCompare(b.client.name);
    if (state.sort === "due") return Number(a.nextDue || Infinity) - Number(b.nextDue || Infinity);
    if (state.sort === "last_payment") return Number(b.lastPaymentDate || 0) - Number(a.lastPaymentDate || 0);
    return b.balance - a.balance;
  }

  function renderClients() {
    const grid = document.querySelector("[data-clients-grid]");
    const rows = filteredSummaries();
    if (!grid) return;
    if (!rows.length) {
      grid.innerHTML = `<div class="empty-state">No clients match the current filters.</div>`;
      return;
    }
    grid.innerHTML = rows.map(clientCard).join("");
  }

  function clientCard(summary) {
    const action = summary.status === "overdue" ? "reminder" : "view";
    const label = summary.status === "overdue" ? "Send Reminder" : "Open Ledger";
    const className = summary.status === "overdue" ? "btn-danger" : "btn-blue";
    return `
      <article class="client-card" data-client-id="${summary.client.id}">
        <div class="client-card-head">
          <div class="client-avatar">${initials(summary.client.name)}</div>
          <div class="client-card-title">
            <h2>${escape(summary.client.name)}</h2>
            <p>${escape(summary.client.phone)}</p>
          </div>
          <span class="status-badge ${window.WLDB.statusClass(summary.status)}">${escape(window.WLDB.statusLabel(summary.status, summary.overdueDays))}</span>
        </div>
        <div class="client-card-metrics">
          <div class="card-stat">
            <span>Outstanding</span>
            <strong>${money(summary.balance)}</strong>
          </div>
          <div class="card-stat">
            <span>Last payment</span>
            <strong>${summary.lastPaymentDate ? window.WLDB.formatDateContext(summary.lastPaymentDate) : "None"}</strong>
          </div>
        </div>
        <div class="progress" aria-label="${summary.paidPercent}% paid"><span style="--value:${summary.paidPercent}%"></span></div>
        <div class="client-card-actions">
          <a class="btn btn-ghost" href="client-detail.html?id=${summary.client.id}">View Ledger</a>
          <button class="btn ${className}" type="button" data-card-action="${action}" data-client-id="${summary.client.id}">${label}</button>
        </div>
      </article>`;
  }

  function handleCardAction(event) {
    const action = event.target.closest("[data-card-action]");
    if (!action) return;
    const summary = state.summaries.find((item) => item.client.id === action.dataset.clientId);
    if (!summary) return;
    if (action.dataset.cardAction === "reminder") {
      sendReminder(summary);
    } else {
      window.location.href = `client-detail.html?id=${summary.client.id}`;
    }
  }

  function openAddClientModal() {
    const modal = document.getElementById("addClientModal");
    modal.querySelector("form").reset();
    modal.querySelector("[name='payment_cycle_days']").value = "30";
    window.WLUI.openModal(modal);
  }

  async function saveClient() {
    const modal = document.getElementById("addClientModal");
    const form = modal.querySelector("form");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const client = await window.WLDB.addClient({
      name: data.get("name"),
      phone: data.get("phone"),
      credit_limit: data.get("credit_limit"),
      payment_cycle_days: data.get("payment_cycle_days")
    });
    window.WLUI.closeModal(modal);
    window.WLNotify.success("Client added", client.name);
    await loadAndRender();
  }

  function sendReminder(summary) {
    const phone = summary.client.phone.replace(/\D/g, "");
    const message = encodeURIComponent(`Hello ${summary.client.name}, this is ${state.business.name}. Your outstanding balance is ${money(summary.balance)}. Please clear it at the earliest.`);
    window.open(`https://wa.me/${phone}?text=${message}`, "_blank", "noopener");
    window.WLNotify.info("Reminder ready", summary.client.name);
  }

  function initials(name) {
    return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function money(value) {
    return window.WLDB.formatCurrency(value, state.settings?.currency_symbol || "₹");
  }

  function escape(value) {
    return window.WLUI.escapeHtml(value);
  }
})();
