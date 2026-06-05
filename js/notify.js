(function () {
  const toastTimers = new WeakMap();
  let unreadCount = 0;

  function ensureToastRoot() {
    let root = document.querySelector("[data-toast-root]");
    if (!root) {
      root = document.createElement("div");
      root.className = "toast-root";
      root.dataset.toastRoot = "true";
      document.body.append(root);
    }
    return root;
  }

  function show(type, title, message) {
    const root = ensureToastRoot();
    const toast = document.createElement("button");
    toast.type = "button";
    toast.className = `toast toast-${type || "info"}`;
    toast.innerHTML = `<strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ""}`;
    toast.addEventListener("click", () => dismiss(toast));
    root.prepend(toast);
    const timer = window.setTimeout(() => dismiss(toast), 4000);
    toastTimers.set(toast, timer);
    bumpUnread();
    return toast;
  }

  function dismiss(toast) {
    if (!toast || !toast.isConnected) return;
    const timer = toastTimers.get(toast);
    if (timer) window.clearTimeout(timer);
    toast.style.opacity = "0";
    toast.style.transform = "translateX(18px)";
    window.setTimeout(() => toast.remove(), 160);
  }

  function bumpUnread() {
    unreadCount += 1;
    setCount(unreadCount);
  }

  function setCount(count) {
    unreadCount = count;
    document.querySelectorAll("[data-notification-count]").forEach((node) => {
      node.textContent = String(count);
      node.hidden = count <= 0;
    });
  }

  function resetCount() {
    setCount(0);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function openModal(id) {
    const modal = typeof id === "string" ? document.getElementById(id) : id;
    if (!modal) return;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    const focusable = modal.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    if (focusable) focusable.focus();
  }

  function closeModal(id) {
    const modal = typeof id === "string" ? document.getElementById(id) : id;
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
  }

  function closeAllModals() {
    document.querySelectorAll(".modal-backdrop.is-open").forEach(closeModal);
  }

  function bindModalDismissals() {
    document.addEventListener("click", (event) => {
      const closeTarget = event.target.closest("[data-close-modal]");
      if (closeTarget) {
        closeModal(closeTarget.closest(".modal-backdrop"));
        return;
      }
      if (event.target.classList.contains("modal-backdrop")) {
        closeModal(event.target);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAllModals();
    });
  }

  function setConnectionStatus(status, label) {
    const isLive = status === "live";
    document.querySelectorAll("[data-connection-status]").forEach((node) => {
      node.classList.toggle("is-live", isLive);
      node.classList.toggle("is-offline", !isLive);
      node.querySelector("[data-connection-label]").textContent = label || (isLive ? "Live" : "Offline");
    });
  }

  function setOfflineState() {
    const offline = !navigator.onLine;
    document.body.classList.toggle("is-offline", offline);
    if (offline) {
      setConnectionStatus("offline", "Offline");
    }
  }

  async function initShell(currentPage) {
    bindModalDismissals();
    setOfflineState();
    window.addEventListener("online", setOfflineState);
    window.addEventListener("offline", setOfflineState);
    window.addEventListener("wl:connection", (event) => {
      setConnectionStatus(event.detail.status, event.detail.label);
    });

    const bell = document.querySelector("[data-notification-bell]");
    if (bell) {
      bell.addEventListener("click", resetCount);
    }

    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("./sw.js");
      } catch (error) {
        console.warn("Service worker registration failed", error);
      }
    }

    if (!window.WLDB) return;
    const [businesses, activeBusiness, settings] = await Promise.all([
      window.WLDB.getBusinesses(),
      window.WLDB.getActiveBusiness(),
      window.WLDB.getSettings()
    ]);

    document.body.dataset.theme = settings.theme || "dark";
    document.querySelectorAll("[data-business-name]").forEach((node) => {
      node.textContent = activeBusiness?.name || "WholesaleLedger";
    });
    document.querySelectorAll("[data-business-prefix]").forEach((node) => {
      node.textContent = activeBusiness?.prefix ? `${activeBusiness.prefix} ledger` : "Device ledger";
    });

    document.querySelectorAll("[data-business-select]").forEach((select) => {
      select.innerHTML = businesses.map((business) => {
        const selected = business.id === activeBusiness?.id ? " selected" : "";
        return `<option value="${business.id}"${selected}>${escapeHtml(business.name)}</option>`;
      }).join("");
      select.addEventListener("change", async () => {
        await window.WLDB.setActiveBusiness(select.value);
        window.location.reload();
      });
    });

    document.querySelectorAll("[data-nav]").forEach((link) => {
      if (link.dataset.nav === currentPage) link.setAttribute("aria-current", "page");
    });
  }

  window.WLNotify = {
    show,
    success: (title, message) => show("success", title, message),
    warning: (title, message) => show("warning", title, message),
    error: (title, message) => show("error", title, message),
    info: (title, message) => show("info", title, message),
    setCount,
    resetCount,
    escapeHtml
  };

  window.WLUI = {
    initShell,
    openModal,
    closeModal,
    closeAllModals,
    setConnectionStatus,
    escapeHtml
  };
})();
