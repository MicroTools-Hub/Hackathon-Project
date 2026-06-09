(function () {
  const state = {
    business: null,
    settings: null,
    confirmAction: null
  };

  document.addEventListener("DOMContentLoaded", initSettings);

  async function initSettings() {
    await window.WLDB.init();
    await window.WLUI.initShell("settings");
    window.WLExport.bindExportButtons();
    bindEvents();
    await loadAndRender();
    await window.WLSSE.start();
  }

  function bindEvents() {
    document.querySelector("[data-save-business]")?.addEventListener("click", saveBusiness);
    document.querySelector("[data-add-number]")?.addEventListener("click", addNumber);
    document.querySelector("[data-save-endpoint]")?.addEventListener("click", saveEndpoint);
    document.querySelector("[data-logout-btn]")?.addEventListener("click", handleLogout);
    document.querySelector("[data-supabase-signout]")?.addEventListener("click", handleLogout);
    document.getElementById("configSsoBtn")?.addEventListener("click", openSsoModal);
    document.getElementById("closeSsoModalBtn")?.addEventListener("click", closeSsoModal);
    document.getElementById("saveSsoClientIdBtn")?.addEventListener("click", saveSsoClientId);
    document.querySelector("[data-test-endpoint]")?.addEventListener("click", testEndpoint);
    document.querySelector("[data-export-json]")?.addEventListener("click", () => window.WLExport.downloadJsonBackup());
    document.querySelector("[data-import-json]")?.addEventListener("click", () => document.querySelector("[data-import-json-file]").click());
    document.querySelector("[data-import-json-file]")?.addEventListener("change", importBackup);
    document.querySelector("[data-clear-data]")?.addEventListener("click", () => openConfirm("Clear all ledger data", "Client, invoice, and payment records for this business will be removed.", async () => {
      await window.WLDB.clearActiveBusinessData();
      window.WLNotify.warning("Data cleared", state.business.name);
      await loadAndRender();
    }));
    document.querySelector("[data-reset-payments]")?.addEventListener("click", () => openConfirm("Reset all payment records", "Invoices and clients remain, but every payment record will be removed.", async () => {
      await window.WLDB.clearPayments();
      window.WLNotify.warning("Payments reset", state.business.name);
      await loadAndRender();
    }));
    document.querySelector("[data-delete-business]")?.addEventListener("click", () => openConfirm("Delete business", "This removes the active business and its local ledger records.", async () => {
      await window.WLDB.deleteActiveBusiness();
      window.WLNotify.error("Business deleted", "A new empty business is active");
      window.setTimeout(() => window.location.reload(), 500);
    }));
    document.querySelector("[data-run-confirm]")?.addEventListener("click", runConfirm);
    document.addEventListener("click", trustedAction);
  }

  let qrPollInterval = null;

  async function loadAndRender() {
    state.business = await window.WLDB.getActiveBusiness();
    state.settings = await window.WLDB.getSettings();
    renderAccount();
    renderBusinessForm();
    renderTrustedNumbers();
    renderConnection();
    if (!qrPollInterval) {
      startQrPolling();
    }
  }

  function renderAccount() {
    const userString = localStorage.getItem("wl_user");
    if (!userString) return;
    const user = JSON.parse(userString);
    const emailNode = document.querySelector("[data-user-email]");
    const nameNode = document.querySelector("[data-user-name]");
    if (emailNode) emailNode.textContent = user.email || "";
    if (nameNode) nameNode.textContent = user.name || "User";

    // Avatar / Letter avatar rendering
    const avatarImg = document.getElementById("userAvatar");
    const letterAvatar = document.getElementById("userLetterAvatar");
    if (user.picture && avatarImg) {
      avatarImg.src = user.picture;
      avatarImg.style.display = "block";
      if (letterAvatar) letterAvatar.style.display = "none";
    } else {
      if (avatarImg) avatarImg.style.display = "none";
      if (letterAvatar) {
        letterAvatar.style.display = "grid";
        const letter = (user.name || user.email || "U").charAt(0).toUpperCase();
        letterAvatar.textContent = letter;
        letterAvatar.style.background = user.avatar_color || "#1a73e8";
      }
    }

    // SSO Configuration status text rendering
    const clientId = localStorage.getItem("wl_google_client_id");
    const ssoStatusText = document.getElementById("ssoStatusText");
    const configSsoBtn = document.getElementById("configSsoBtn");
    if (ssoStatusText) {
      if (clientId) {
        ssoStatusText.textContent = "SSO: Active (Client ID Set)";
        ssoStatusText.style.color = "var(--green)";
        if (configSsoBtn) configSsoBtn.textContent = "Change ID";
      } else {
        ssoStatusText.textContent = "SSO: Not configured";
        ssoStatusText.style.color = "var(--muted)";
        if (configSsoBtn) configSsoBtn.textContent = "Setup ID";
      }
    }
  }

  async function renderWhatsAppConnection() {
    const statusNode = document.querySelector("[data-whatsapp-status]");
    const slotNode = document.getElementById("whatsappQrSlot");
    if (!statusNode || !slotNode) return;

    const endpoint = state.settings.sse_endpoint || "";
    const apiBase = endpoint.replace(/\/sse\/?$/, "");
    if (!apiBase) {
      statusNode.textContent = "Simulator Mode";
      statusNode.className = "status-badge status-neutral";
      slotNode.innerHTML = `<p style="color:#666; font-size:0.9rem; margin:0; text-align:center;">Working Offline / Simulator</p>`;
      return;
    }

    try {
      const response = await fetch(`${apiBase}/api/qr`, {
        headers: { "ngrok-skip-browser-warning": "69420" }
      }).catch(() => null);
      if (!response) {
        statusNode.textContent = "Disconnected";
        statusNode.className = "status-badge status-overdue";
        slotNode.innerHTML = `<p style="color:#c0392b; font-size:0.85rem; margin:0; text-align:center; padding:10px;">Backend Unreachable</p>`;
        return;
      }
      const data = await response.json();
      const status = data.status || "disconnected";
      statusNode.textContent = status;

      if (status === "connected") {
        statusNode.className = "status-badge status-paid";
        slotNode.innerHTML = `
          <div style="text-align:center; color:#27ae60;">
            <svg style="width:48px; height:48px; margin:0 auto 0.5rem;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p style="font-weight:700; font-size:0.95rem; margin:0;">WhatsApp Connected</p>
          </div>
        `;
      } else if (status === "connecting" || status === "disconnected" || status === "qr_pending") {
        statusNode.className = status === "connecting" ? "status-badge status-due-soon" : "status-badge status-overdue";
        if (data.qr || data.image) {
          slotNode.innerHTML = `<img src="${data.qr || data.image}" alt="WhatsApp QR" style="width:200px; height:200px; display:block;">`;
        } else {
          slotNode.innerHTML = `<p style="color:#666; font-size:0.85rem; margin:0; text-align:center; padding:10px;">Generating QR code...</p>`;
        }
      } else {
        statusNode.className = "status-badge status-overdue";
        slotNode.innerHTML = `<p style="color:#666; font-size:0.85rem; margin:0; text-align:center; padding:10px;">Unknown status</p>`;
      }
    } catch (error) {
      console.error("Failed to fetch WhatsApp QR status:", error);
    }
  }

  function startQrPolling() {
    renderWhatsAppConnection();
    qrPollInterval = setInterval(renderWhatsAppConnection, 1000);
  }

  function renderBusinessForm() {
    document.querySelector("[name='business_name']").value = state.business?.name || "";
    document.querySelector("[name='business_prefix']").value = state.business?.prefix || "";
    document.querySelector("[name='currency_symbol']").value = state.settings.currency_symbol || "₹";
    document.querySelector("[name='theme']").value = state.settings.theme || "dark";
  }

  async function renderTrustedNumbers() {
    const list = document.querySelector("[data-trusted-list]");
    const stats = await window.WLDB.getTrustedNumberStats();
    if (!stats.length) {
      list.innerHTML = `<div class="empty-state">No trusted WhatsApp numbers configured.</div>`;
      return;
    }
    list.innerHTML = stats.map((number) => `
      <article class="trusted-row">
        <div class="trusted-main">
          <div>
            <strong>${escape(number.phone)}</strong>
            <span>${escape(number.label)}</span>
          </div>
          <label class="toggle" aria-label="Toggle ${escape(number.phone)}">
            <input type="checkbox" data-toggle-number="${escape(number.phone)}" ${number.active ? "checked" : ""}>
            <span></span>
          </label>
        </div>
        <div class="trusted-stats">
          Last message ${number.last_message_at ? window.WLDB.formatDateContext(number.last_message_at) : "not recorded"} · ${number.paymentCount} payments recorded
        </div>
        <button class="btn btn-danger" type="button" data-remove-number="${escape(number.phone)}">Remove</button>
      </article>`).join("");
  }

  function renderConnection() {
    document.querySelector("[name='sse_endpoint']").value = state.settings.sse_endpoint || "";
    const log = document.querySelector("[data-connection-log]");
    const entries = state.settings.connection_log || [];
    log.innerHTML = entries.length
      ? entries.map((entry) => `<div class="connection-log-item">${window.WLDB.formatDateContext(entry.at)} · ${escape(entry.message)}</div>`).join("")
      : `<div class="empty-state">No connection events yet.</div>`;
  }

  async function saveBusiness() {
    const form = document.querySelector("[data-business-form]");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    await window.WLDB.saveBusinessSetup({
      name: data.get("business_name"),
      prefix: data.get("business_prefix"),
      currency_symbol: data.get("currency_symbol"),
      theme: data.get("theme")
    });
    document.body.dataset.theme = data.get("theme");
    window.WLNotify.success("Business updated", data.get("business_name"));
    await loadAndRender();
  }

  async function addNumber() {
    const form = document.querySelector("[data-number-form]");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    await window.WLDB.addTrustedNumber(data.get("phone"), data.get("label"));
    form.reset();
    window.WLNotify.success("Trusted number added", data.get("phone"));
    await loadAndRender();
  }

  async function trustedAction(event) {
    const remove = event.target.closest("[data-remove-number]");
    if (remove) {
      await window.WLDB.removeTrustedNumber(remove.dataset.removeNumber);
      window.WLNotify.info("Trusted number removed", remove.dataset.removeNumber);
      await loadAndRender();
      return;
    }
    const toggle = event.target.closest("[data-toggle-number]");
    if (toggle) {
      await window.WLDB.toggleTrustedNumber(toggle.dataset.toggleNumber, toggle.checked);
      window.WLNotify.info("Trusted number updated", toggle.dataset.toggleNumber);
      await loadAndRender();
    }
  }

  async function saveEndpoint() {
    const endpoint = document.querySelector("[name='sse_endpoint']").value.trim();
    await window.WLDB.saveSettings({ sse_endpoint: endpoint });
    await window.WLDB.appendConnectionLog(endpoint ? "SSE endpoint saved" : "SSE endpoint cleared; simulator active", "info");
    window.WLNotify.success("Connection saved", endpoint || "Development simulator");
    await loadAndRender();
    await window.WLSSE.start();
  }

  async function testEndpoint() {
    const endpoint = document.querySelector("[name='sse_endpoint']").value.trim();
    const result = await window.WLSSE.testConnection(endpoint);
    if (result.ok) window.WLNotify.success("Connection test passed", result.message);
    else window.WLNotify.error("Connection test failed", result.message);
    await loadAndRender();
  }

  async function importBackup(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await window.WLExport.importJsonBackup(file);
    } catch (error) {
      window.WLNotify.error("Import failed", error.message);
    } finally {
      event.target.value = "";
    }
  }

  function openConfirm(title, body, action) {
    state.confirmAction = action;
    const modal = document.getElementById("confirmModal");
    modal.querySelector("[data-confirm-title]").textContent = title;
    modal.querySelector("[data-confirm-body]").textContent = body;
    modal.querySelector("[data-confirm-name]").textContent = state.business.name;
    modal.querySelector("[name='confirm_text']").value = "";
    window.WLUI.openModal(modal);
  }

  async function runConfirm() {
    const modal = document.getElementById("confirmModal");
    const input = modal.querySelector("[name='confirm_text']");
    if (input.value.trim() !== state.business.name) {
      window.WLNotify.error("Confirmation mismatch", "Type the business name exactly");
      input.focus();
      return;
    }
    if (state.confirmAction) await state.confirmAction();
    state.confirmAction = null;
    window.WLUI.closeModal(modal);
  }

  function openSsoModal() {
    const modal = document.getElementById("ssoConfigModal");
    if (modal) {
      modal.style.display = "grid";
      const saved = localStorage.getItem("wl_google_client_id");
      const input = document.getElementById("clientIdInput");
      if (input) input.value = saved || "";
    }
  }

  function closeSsoModal() {
    const modal = document.getElementById("ssoConfigModal");
    if (modal) modal.style.display = "none";
  }

  function saveSsoClientId() {
    const input = document.getElementById("clientIdInput");
    const val = input ? input.value.trim() : "";
    if (!val) {
      window.WLNotify.error("Validation error", "Google Client ID is required.");
      return;
    }
    localStorage.setItem("wl_google_client_id", val);
    window.WLNotify.success("Settings saved", "Google SSO Client ID updated");
    closeSsoModal();
    loadAndRender();
  }

  async function handleLogout() {
    try {
      if (window.WLSync) window.WLSync.stop();
    } catch (e) { console.warn("WLSync.stop failed:", e); }
    try {
      if (window.WLAuth) await window.WLAuth.signOut();
    } catch (e) { console.warn("WLAuth.signOut failed:", e); }
    localStorage.removeItem("wl_user");
    localStorage.removeItem("wl_last_sync_time");
    try {
      await window.WLDB.clearLocalLedgerData();
    } catch (err) {
      console.error("Failed to clear local ledger data on logout:", err);
    }
    window.location.href = "login.html";
  }

  function escape(value) {
    return window.WLUI.escapeHtml(value);
  }
})();
