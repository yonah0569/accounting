const el = (id) => document.getElementById(id);
const money = (n) => `$${Number(n).toFixed(2)}`;

async function api(path, options) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let currentFilters = { pcName: "", state: "", insurance: "" };

function badgeClass(status) {
  if (status === "Paid") return "paid";
  if (status === "Sent") return "sent";
  return "not-sent";
}

function renderFilterOptions(selectEl, values, current) {
  const options = ['<option value="">All</option>', ...values.map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${v}</option>`)];
  selectEl.innerHTML = options.join("");
}

function renderGroups(clients) {
  const container = el("db-groups");
  if (!clients.length) {
    container.innerHTML = '<p class="db-empty">No imported tasks match these filters.</p>';
    return;
  }

  container.innerHTML = clients
    .map((c, ci) => `
      <div class="db-client" data-client-index="${ci}">
        <div class="db-client-header" data-toggle="${ci}">
          <div>
            <div class="db-client-name">${c.clientName}</div>
            <div class="db-client-meta">${c.providers.length} provider${c.providers.length === 1 ? "" : "s"}</div>
          </div>
          <div class="db-client-totals">
            <span>Total<strong>${money(c.total)}</strong></span>
            <span>Paid<strong>${money(c.paid)}</strong></span>
            <span>Owed Now<strong>${money(c.owedNow)}</strong></span>
            <span>Will Owe<strong>${money(c.willOwe)}</strong></span>
          </div>
          <div class="db-client-toggle">▾ expand</div>
        </div>
        <div class="db-client-body">
          ${c.providers
            .map(
              (p) => `
            <div class="db-provider">
              <div class="db-provider-name">${p.providerName}</div>
              <table class="db-task-table">
                <thead>
                  <tr>
                    <th>Payer</th><th>State</th><th>ClickUp Status</th>
                    <th>Deposit</th><th>Deposit Status</th>
                    <th>Balance</th><th>Balance Status</th><th>Total</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  ${p.tasks
                    .map(
                      (t) => `
                    <tr data-task-id="${t.id}">
                      <td>${t.payerName || "—"}</td>
                      <td>${t.state || "—"}</td>
                      <td>${t.clickupStatus}</td>
                      <td><input type="number" step="0.01" class="edit-field" data-field="depositDue" value="${t.depositDue}" /></td>
                      <td><select class="edit-field" data-field="depositPaymentStatus">
                        ${["Not Sent", "Sent", "Paid"].map((s) => `<option value="${s}" ${s === t.depositPaymentStatus ? "selected" : ""}>${s}</option>`).join("")}
                      </select></td>
                      <td>${t.balanceBillable ? `<input type="number" step="0.01" class="edit-field" data-field="balanceDue" value="${t.balanceDue}" />` : `<span title="Not yet billable">${money(t.balanceDue)}</span>`}</td>
                      <td>${t.balanceBillable ? `<select class="edit-field" data-field="balancePaymentStatus">${["Not Sent", "Sent", "Paid"].map((s) => `<option value="${s}" ${s === t.balancePaymentStatus ? "selected" : ""}>${s}</option>`).join("")}</select>` : `<span class="db-badge not-sent">N/A</span>`}</td>
                      <td><input type="number" step="0.01" class="edit-field" data-field="totalFee" value="${t.totalFee}" /></td>
                      <td>${t.clickupTaskUrl ? `<a href="${t.clickupTaskUrl}" target="_blank" rel="noopener">ClickUp</a>` : ""}</td>
                    </tr>`
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
            )
            .join("")}
        </div>
      </div>`
    )
    .join("");

  container.querySelectorAll(".db-client-header").forEach((header) => {
    header.addEventListener("click", () => header.closest(".db-client").classList.toggle("expanded"));
  });

  container.querySelectorAll(".edit-field").forEach((field) => {
    field.addEventListener("change", async () => {
      const taskId = field.closest("tr").dataset.taskId;
      const payload = {};
      payload[field.dataset.field] = field.type === "number" ? Number(field.value) : field.value;
      try {
        await api(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(payload) });
        await loadDashboard();
      } catch (err) {
        alert(`Failed to save: ${err.message}`);
      }
    });
  });
}

async function loadDashboard() {
  const params = new URLSearchParams();
  if (currentFilters.pcName) params.set("pcName", currentFilters.pcName);
  if (currentFilters.state) params.set("state", currentFilters.state);
  if (currentFilters.insurance) params.set("insurance", currentFilters.insurance);

  const data = await api(`/api/dashboard?${params.toString()}`);

  el("sum-total").textContent = money(data.grandTotals.total);
  el("sum-paid").textContent = money(data.grandTotals.paid);
  el("sum-owed").textContent = money(data.grandTotals.owedNow);
  el("sum-will-owe").textContent = money(data.grandTotals.willOwe);

  renderFilterOptions(el("filter-pc"), data.filterOptions.pcNames, currentFilters.pcName);
  renderFilterOptions(el("filter-state"), data.filterOptions.states, currentFilters.state);
  renderFilterOptions(el("filter-insurance"), data.filterOptions.insurances, currentFilters.insurance);

  renderGroups(data.clients);
}

function describeSchedule(status, { succeededLabel, resultText }) {
  const next = status.nextRunAt ? new Date(status.nextRunAt).toLocaleString() : "not yet scheduled (runs on next server start)";
  const last = status.lastRunAt
    ? `Last run ${new Date(status.lastRunAt).toLocaleString()} (${resultText(status.lastResult)})`
    : "Never run yet";
  return `${last}. Next scheduled: ${next}.`;
}

async function loadSyncStatus() {
  try {
    const status = await api("/api/quickbooks/schedule-status");
    el("invoice-sync-status-text").textContent = "New invoices: " + describeSchedule(status.invoiceSync, {
      resultText: (r) => `${r?.succeeded ?? 0} synced, ${r?.failed ?? 0} failed`,
    });
    el("payment-check-status-text").textContent = "Payment check: " + describeSchedule(status.paymentCheck, {
      resultText: (r) => `${r?.updated ?? 0} tasks updated, ${r?.newlyPaid?.length ?? 0} newly marked Paid`,
    });
  } catch {
    el("invoice-sync-status-text").textContent = "Could not load sync schedule.";
    el("payment-check-status-text").textContent = "";
  }
}

async function loadQbStatus() {
  const statusEl = el("qb-status");
  try {
    const status = await api("/auth/quickbooks/status");
    if (status.connected) {
      statusEl.textContent = `QuickBooks connected (Realm ${status.realmId})`;
      statusEl.className = "qb-status connected";
    } else {
      statusEl.innerHTML = `QuickBooks not connected <a href="/auth/quickbooks" target="_blank" rel="noopener">Connect</a>`;
      statusEl.className = "qb-status disconnected";
    }
  } catch {
    statusEl.textContent = "Could not check QuickBooks status";
  }
}

const monthLabel = (ym) => {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString(undefined, { month: "short", year: "2-digit" });
};

async function loadGrowth() {
  const container = el("db-growth-chart");
  try {
    const { months } = await api("/api/dashboard/growth");
    if (!months.length) {
      container.innerHTML = '<p class="db-empty">No dated enrollments imported yet.</p>';
      return;
    }
    const max = Math.max(...months.map((m) => m.total));
    container.innerHTML = months
      .map((m) => {
        const heightPct = max > 0 ? Math.max(4, (m.total / max) * 100) : 4;
        const pct = m.growthPct;
        const pctHtml =
          pct === null
            ? ""
            : `<span class="db-growth-pct ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}%</span>`;
        return `
          <div class="db-growth-bar-wrap">
            <span class="db-growth-value">${money(m.total)}</span>
            ${pctHtml}
            <div class="db-growth-bar" style="height:${heightPct}px"></div>
            <span class="db-growth-month">${monthLabel(m.month)}</span>
          </div>`;
      })
      .join("");
  } catch (err) {
    container.innerHTML = `<p class="db-empty">Could not load growth data: ${err.message}</p>`;
  }
}

function init() {
  loadQbStatus();
  loadSyncStatus();
  loadDashboard();
  loadGrowth();

  ["filter-pc", "filter-state", "filter-insurance"].forEach((id) => {
    el(id).addEventListener("change", (e) => {
      const key = id === "filter-pc" ? "pcName" : id === "filter-state" ? "state" : "insurance";
      currentFilters[key] = e.target.value;
      loadDashboard();
    });
  });

  el("clear-filters-btn").addEventListener("click", () => {
    currentFilters = { pcName: "", state: "", insurance: "" };
    loadDashboard();
  });

  el("sync-now-btn").addEventListener("click", async () => {
    const btn = el("sync-now-btn");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      const result = await api("/api/quickbooks/batch-sync", { method: "POST" });
      alert(`Sync complete: ${result.succeeded} synced, ${result.failed} failed, ${result.attempted} attempted.`);
      await loadSyncStatus();
      await loadDashboard();
    } catch (err) {
      alert(`Sync failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Sync New Invoices Now";
    }
  });

  el("check-payments-btn").addEventListener("click", async () => {
    const btn = el("check-payments-btn");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const result = await api("/api/quickbooks/refresh-all-payments", { method: "POST" });
      alert(`Checked ${result.invoicesChecked} invoices. ${result.updated} tasks updated, ${result.newlyPaid.length} newly marked Paid.`);
      await loadSyncStatus();
      await loadDashboard();
    } catch (err) {
      alert(`Check failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Check for Payments Now";
    }
  });
}

init();
