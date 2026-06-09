(function () {
  async function openExcelModal() {
    const modal = await ensureExcelModal();
    window.WLUI.openModal(modal);
  }

  async function ensureExcelModal() {
    let modal = document.getElementById("excelExportModal");
    if (modal) {
      await populateClientOptions(modal);
      return modal;
    }
    modal = document.createElement("div");
    modal.id = "excelExportModal";
    modal.className = "modal-backdrop";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h2 class="modal-title">Export Ledger</h2>
          <button class="icon-btn" type="button" data-close-modal aria-label="Close export modal">×</button>
        </div>
        <form class="modal-body form-grid" data-excel-export-form>
          <div class="field">
            <label for="exportRange">Date range</label>
            <select class="field-control" id="exportRange" name="range">
              <option value="this_month">This month</option>
              <option value="last_month">Last month</option>
              <option value="custom">Custom range</option>
            </select>
          </div>
          <div class="field-row" data-custom-range hidden>
            <div class="field">
              <label for="exportFrom">From</label>
              <input class="field-control" id="exportFrom" name="from" type="date">
            </div>
            <div class="field">
              <label for="exportTo">To</label>
              <input class="field-control" id="exportTo" name="to" type="date">
            </div>
          </div>
          <div class="field">
            <label>Clients</label>
            <div class="filter-row" data-export-client-list></div>
          </div>
        </form>
        <div class="modal-foot">
          <button class="btn btn-ghost" type="button" data-close-modal>Cancel</button>
          <button class="btn btn-primary" type="button" data-run-excel-export>Export XLSX</button>
        </div>
      </div>`;
    document.body.append(modal);
    const range = modal.querySelector("#exportRange");
    range.addEventListener("change", () => {
      modal.querySelector("[data-custom-range]").hidden = range.value !== "custom";
    });
    modal.querySelector("[data-run-excel-export]").addEventListener("click", async () => {
      const form = modal.querySelector("[data-excel-export-form]");
      const data = new FormData(form);
      const clientIds = [...modal.querySelectorAll("[data-export-client]:checked")].map((input) => input.value);
      await exportExcel({
        range: data.get("range"),
        from: data.get("from"),
        to: data.get("to"),
        clientIds
      });
      window.WLUI.closeModal(modal);
    });
    await populateClientOptions(modal);
    return modal;
  }

  async function populateClientOptions(modal) {
    const clients = await window.WLDB.getClients();
    const list = modal.querySelector("[data-export-client-list]");
    list.innerHTML = `
      <label class="filter-tab"><input type="checkbox" data-export-client value="all" checked> All clients</label>
      ${clients.map((client) => `
        <label class="filter-tab"><input type="checkbox" data-export-client value="${client.id}"> ${window.WLUI.escapeHtml(client.name)}</label>
      `).join("")}`;
    const all = list.querySelector("input[value='all']");
    all.addEventListener("change", () => {
      if (all.checked) {
        list.querySelectorAll("input:not([value='all'])").forEach((input) => { input.checked = false; });
      }
    });
    list.querySelectorAll("input:not([value='all'])").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) all.checked = false;
        if (![...list.querySelectorAll("input:not([value='all'])")].some((item) => item.checked)) all.checked = true;
      });
    });
  }

  function resolveRange(range, from, to) {
    const now = new Date();
    if (range === "last_month") {
      return {
        start: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
        end: new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      };
    }
    if (range === "custom" && from && to) {
      const start = new Date(`${from}T00:00:00`).getTime();
      const end = new Date(`${to}T23:59:59`).getTime();
      return { start, end };
    }
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()
    };
  }

  function autofitColumns(worksheet) {
    if (!worksheet || !worksheet['!ref']) return;
    const range = window.XLSX.utils.decode_range(worksheet['!ref']);
    const cols = [];
    for (let C = range.s.c; C <= range.e.c; ++C) {
      let maxLen = 10; // default minimum width
      for (let R = range.s.r; R <= range.e.r; ++R) {
        const cell = worksheet[window.XLSX.utils.encode_cell({ c: C, r: R })];
        if (cell && cell.v !== undefined && cell.v !== null) {
          const valStr = cell.w ? String(cell.w) : String(cell.v);
          maxLen = Math.max(maxLen, valStr.length);
        }
      }
      cols.push({ wch: maxLen + 3 }); // add padding
    }
    worksheet['!cols'] = cols;
  }

  function formatSheetCells(worksheet, numericColumns) {
    if (!worksheet || !worksheet['!ref']) return;
    const range = window.XLSX.utils.decode_range(worksheet['!ref']);
    const headers = [];
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cell = worksheet[window.XLSX.utils.encode_cell({ c: C, r: 0 })];
      headers.push(cell ? String(cell.v).trim() : '');
    }

    for (let R = 1; R <= range.e.r; ++R) {
      for (let C = range.s.c; C <= range.e.c; ++C) {
        const header = headers[C];
        if (!numericColumns.includes(header)) continue;
        
        const cellRef = window.XLSX.utils.encode_cell({ c: C, r: R });
        const cell = worksheet[cellRef];
        if (cell && typeof cell.v === 'number') {
          cell.t = 'n'; // ensure type is number
          if (header === "Days Overdue") {
            cell.z = '#,##0'; // integer format
          } else if (header === "Confidence") {
            cell.z = '0.00'; // decimal format
          } else {
            cell.z = '#,##0.00'; // standard comma-separated currency/number format
          }
        }
      }
    }
  }

  async function exportExcel(options = {}) {
    if (!window.XLSX) {
      window.WLNotify.error("Export unavailable", "SheetJS is not loaded");
      return;
    }
    const settings = await window.WLDB.getSettings();
    const { business, clients, payments } = await window.WLDB.getBusinessData();
    const summaries = await window.WLDB.computeClientSummaries();
    const selected = !options.clientIds?.length || options.clientIds.includes("all")
      ? new Set(clients.map((client) => client.id))
      : new Set(options.clientIds);
    const { start, end } = resolveRange(options.range, options.from, options.to);
    const activeSummaries = summaries.filter((summary) => selected.has(summary.client.id));
    const paymentsInRange = payments
      .filter((payment) => selected.has(payment.client_id))
      .filter((payment) => Number(payment.recorded_at) >= start && Number(payment.recorded_at) <= end);

    const clientName = (id) => clients.find((client) => client.id === id)?.name || "Unknown";
    const invoiceRef = (id) => id ? `INV-${String(id).slice(0, 8).toUpperCase()}` : "";
    const modeBreakdown = (summary) => {
      const map = new Map();
      summary.payments.forEach((payment) => {
        map.set(payment.mode, (map.get(payment.mode) || 0) + Number(payment.amount || 0));
      });
      return [...map.entries()].map(([mode, amount]) => `${mode}: ${window.WLDB.formatCurrency(amount, settings.currency_symbol)}`).join(", ");
    };

    const summaryRows = activeSummaries.map((summary) => ({
      "Client Name": summary.client.name,
      "Total Invoiced": summary.totalInvoiced,
      "Total Paid": summary.totalPaid,
      "Balance": summary.balance,
      "Overdue Amount": summary.overdueAmount,
      "Last Payment Date": summary.lastPaymentDate ? window.WLDB.formatDateContext(summary.lastPaymentDate) : "",
      "Payment Mode breakdown": modeBreakdown(summary)
    }));

    const paymentRows = paymentsInRange.map((payment) => ({
      "Date": new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(payment.recorded_at)),
      "Time": new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(new Date(payment.recorded_at)),
      "Client": clientName(payment.client_id),
      "Amount": payment.amount,
      "Mode": payment.mode,
      "Source": window.WLDB.sourceLabel(payment.source),
      "Recorded By (number)": payment.source_number,
      "Invoice #": invoiceRef(payment.invoice_id),
      "Notes": payment.notes || payment.raw_input,
      "Confidence": payment.confidence
    }));

    const overdueRows = activeSummaries
      .filter((summary) => summary.status === "overdue")
      .map((summary) => ({
        "Client": summary.client.name,
        "Balance": summary.balance,
        "Overdue Amount": summary.overdueAmount,
        "Days Overdue": summary.overdueDays,
        "Last Contact Date": summary.lastPaymentDate ? window.WLDB.formatDateContext(summary.lastPaymentDate) : "No recent payment"
      }));

    const workbook = window.XLSX.utils.book_new();

    const summarySheet = window.XLSX.utils.json_to_sheet(summaryRows);
    formatSheetCells(summarySheet, ["Total Invoiced", "Total Paid", "Balance", "Overdue Amount"]);
    autofitColumns(summarySheet);
    window.XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");

    const paymentSheet = window.XLSX.utils.json_to_sheet(paymentRows);
    formatSheetCells(paymentSheet, ["Amount", "Confidence"]);
    autofitColumns(paymentSheet);
    window.XLSX.utils.book_append_sheet(workbook, paymentSheet, "All Payments");

    const overdueSheet = window.XLSX.utils.json_to_sheet(overdueRows);
    formatSheetCells(overdueSheet, ["Balance", "Overdue Amount", "Days Overdue"]);
    autofitColumns(overdueSheet);
    window.XLSX.utils.book_append_sheet(workbook, overdueSheet, "Overdue");

    const month = new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date(start));
    const year = new Date(start).getFullYear();
    const filename = `WholesaleLedger_${safeFileName(business?.name || "Business")}_${month}_${year}.xlsx`;
    window.XLSX.writeFile(workbook, filename);
    window.WLNotify.success("Excel exported", filename);
  }

  async function exportClientPdf(clientId) {
    if (!window.jspdf?.jsPDF) {
      window.WLNotify.error("PDF unavailable", "jsPDF is not loaded");
      return;
    }
    const settings = await window.WLDB.getSettings();
    const business = await window.WLDB.getActiveBusiness();
    const ledger = await window.WLDB.getClientLedger(clientId);
    const doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
    const rows = buildStatementRows(ledger, settings.currency_symbol);
    const now = Date.now();
    const title = `${business?.name || "Business"} Statement`;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(title, 40, 44);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Client: ${ledger.client.name}`, 40, 64);
    doc.text(`Generated: ${window.WLDB.formatDateContext(now)}`, 40, 80);
    doc.text(`Period: Current ledger`, 40, 96);

    doc.autoTable({
      startY: 122,
      head: [["Date", "Description", "Debit", "Credit", "Balance"]],
      body: rows,
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 5 },
      headStyles: { fillColor: [13, 15, 14], textColor: [240, 235, 225] },
      columnStyles: {
        2: { halign: "right" },
        3: { halign: "right" },
        4: { halign: "right" }
      }
    });

    const finalY = doc.lastAutoTable.finalY + 24;
    const nextDue = ledger.summary.nextDue ? window.WLDB.formatDateContext(ledger.summary.nextDue) : "No open due date";
    doc.setFont("helvetica", "bold");
    doc.text(`Total outstanding: ${window.WLDB.formatCurrency(ledger.summary.balance, settings.currency_symbol)}`, 40, finalY);
    doc.setFont("helvetica", "normal");
    doc.text(`Next due date: ${nextDue}`, 40, finalY + 16);
    doc.text(`Business contact: ${(business?.trusted_numbers || [])[0] || "Not set"}`, 40, finalY + 32);

    const month = new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date());
    const filename = `Statement_${safeFileName(ledger.client.name)}_${month}_${new Date().getFullYear()}.pdf`;
    doc.save(filename);
    window.WLNotify.success("Statement exported", filename);
  }

  function buildStatementRows(ledger, symbol) {
    const entries = [];
    ledger.invoices.forEach((invoice) => {
      entries.push({
        at: Number(invoice.created_at),
        description: `Invoice ${String(invoice.id).slice(0, 8).toUpperCase()}`,
        debit: Number(invoice.amount),
        credit: 0
      });
    });
    ledger.payments
      .filter((payment) => payment.status === "confirmed")
      .forEach((payment) => {
        entries.push({
          at: Number(payment.recorded_at),
          description: `Payment - ${payment.mode}`,
          debit: 0,
          credit: Number(payment.amount)
        });
      });
    let balance = 0;
    return entries
      .sort((a, b) => a.at - b.at)
      .map((entry) => {
        balance += entry.debit - entry.credit;
        return [
          window.WLDB.formatDateContext(entry.at),
          entry.description,
          entry.debit ? window.WLDB.formatCurrency(entry.debit, symbol) : "",
          entry.credit ? window.WLDB.formatCurrency(entry.credit, symbol) : "",
          window.WLDB.formatCurrency(balance, symbol)
        ];
      });
  }

  async function downloadJsonBackup() {
    const business = await window.WLDB.getActiveBusiness();
    const data = await window.WLDB.snapshot();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    downloadBlob(blob, `WholesaleLedger_${safeFileName(business?.name || "Business")}_backup.json`);
    window.WLNotify.success("Backup exported", "JSON backup downloaded");
  }

  async function importJsonBackup(file) {
    const text = await file.text();
    const payload = JSON.parse(text);
    await window.WLDB.importSnapshot(payload);
    window.WLNotify.success("Backup imported", "Reloading ledger");
    window.setTimeout(() => window.location.reload(), 500);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function safeFileName(value) {
    return String(value).replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "");
  }

  function bindExportButtons() {
    document.addEventListener("click", (event) => {
      const exportButton = event.target.closest("[data-open-export]");
      if (exportButton) openExcelModal();
    });
  }

  window.WLExport = {
    openExcelModal,
    exportExcel,
    exportClientPdf,
    downloadJsonBackup,
    importJsonBackup,
    bindExportButtons
  };
})();
