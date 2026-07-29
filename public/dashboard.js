const el = (id) => document.getElementById(id);
const money = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function api(path, options) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let currentFilters = { pcName: "", state: "", insurance: "" };

const statusPill = (label, status) =>
  `<span class="pill pill-${status.toLowerCase().replace(/\s+/g, "-")}">${label} ${status}</span>`;

function renderFilterOptions(selectEl, values, current) {
  selectEl.innerHTML = [
    '<option value="">All</option>',
    ...values.map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${v}</option>`),
  ].join("");
}

function providerRow(p) {
  return `
    <tr data-task-id="${p.id}">
      <td>${p.providerName}</td>
      <td class="col-status">${p.clickupStatus || "—"}</td>
      <td class="col-num"><input type="number" step="0.01" class="edit-field" data-field="totalFee" value="${p.totalFee}" /></td>
      <td class="col-pills">
        ${statusPill("Deposit", p.depositPaymentStatus)}
        ${p.balanceBillable ? statusPill("Balance", p.balancePaymentStatus) : '<span class="pill pill-na">Balance N/A</span>'}
      </td>
      <td class="col-link">${p.clickupTaskUrl ? `<a href="${p.clickupTaskUrl}" target="_blank" rel="noopener">ClickUp ↗</a>` : ""}</td>
    </tr>`;
}

function stateBlock(st) {
  const groupFeeHtml = st.groupFee
    ? `<tr class="group-fee-row" data-task-id="${st.groupFee.id}">
         <td><strong>Group enrollment</strong><span class="muted-note">covers the practice with this payer</span></td>
         <td class="col-status">${st.groupFee.clickupStatus || "—"}</td>
         <td class="col-num"><input type="number" step="0.01" class="edit-field" data-field="totalFee" value="${st.groupFee.totalFee}" /></td>
         <td class="col-pills">
           ${statusPill("Deposit", st.groupFee.depositPaymentStatus)}
           ${st.groupFee.balanceBillable ? statusPill("Balance", st.groupFee.balancePaymentStatus) : '<span class="pill pill-na">Balance N/A</span>'}
         </td>
         <td class="col-link">${st.groupFee.clickupTaskUrl ? `<a href="${st.groupFee.clickupTaskUrl}" target="_blank" rel="noopener">ClickUp ↗</a>` : ""}</td>
       </tr>`
    : "";

  const billableProviders = st.providers.filter((p) => p.totalFee > 0);
  const includedProviders = st.providers.filter((p) => p.totalFee === 0 && !p.isDuplicate);
  const duplicateProviders = st.providers.filter((p) => p.totalFee === 0 && p.isDuplicate);

  const includedHtml = includedProviders.length
    ? `<tr class="included-row">
         <td colspan="5"><span class="muted-note">Included at no extra charge: ${includedProviders.map((p) => p.providerName).join(", ")}</span></td>
       </tr>`
    : "";

  const duplicateHtml = duplicateProviders.length
    ? `<tr class="included-row">
         <td colspan="5"><span class="muted-note">Duplicate entries, not billed again: ${duplicateProviders.map((p) => p.providerName).join(", ")}</span></td>
       </tr>`
    : "";

  return `
    <details class="state-block">
      <summary>
        <span class="state-name">${st.state}</span>
        <span class="state-meta">${st.providers.length + (st.groupFee ? 1 : 0)} provider${st.providers.length === 0 && st.groupFee ? "" : "s"}</span>
        <span class="state-total">${money(st.total)}</span>
      </summary>
      <table class="detail-table">
        <thead>
          <tr><th>Provider</th><th>ClickUp Status</th><th class="col-num">Amount</th><th>Billing</th><th></th></tr>
        </thead>
        <tbody>
          ${groupFeeHtml}
          ${billableProviders.map(providerRow).join("")}
          ${includedHtml}
          ${duplicateHtml}
        </tbody>
      </table>
    </details>`;
}

function payerBlock(payer) {
  return `
    <details class="payer-block">
      <summary>
        <span class="payer-name">${payer.payerName}</span>
        <span class="payer-meta">${payer.states.length} state${payer.states.length === 1 ? "" : "s"}</span>
        <span class="payer-total">${money(payer.total)}</span>
      </summary>
      <div class="payer-body">${payer.states.map(stateBlock).join("")}</div>
    </details>`;
}

function clientBlock(c) {
  return `
    <details class="client-block">
      <summary>
        <span class="client-name">${c.clientName}</span>
        <span class="client-figures">
          <span><em>Total</em>${money(c.total)}</span>
          <span class="fig-paid"><em>Paid</em>${money(c.paid)}</span>
          <span class="fig-owed"><em>Owed now</em>${money(c.owedNow)}</span>
          <span class="fig-will"><em>Not yet billed</em>${money(c.willOwe)}</span>
        </span>
      </summary>
      <div class="client-body">${c.payers.map(payerBlock).join("")}</div>
    </details>`;
}

function wireEdits(container) {
  container.querySelectorAll(".edit-field").forEach((field) => {
    field.addEventListener("change", async () => {
      const taskId = field.closest("tr").dataset.taskId;
      try {
        await api(`/api/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify({ totalFee: Number(field.value) }),
        });
        await loadDashboard();
      } catch (err) {
        alert(`Could not save: ${err.message}`);
      }
    });
  });
}

async function loadDashboard() {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(currentFilters)) if (v) params.set(k, v);

  const data = await api(`/api/dashboard?${params.toString()}`);

  el("sum-total").textContent = money(data.grandTotals.total);
  el("sum-paid").textContent = money(data.grandTotals.paid);
  el("sum-owed").textContent = money(data.grandTotals.owedNow);
  el("sum-will-owe").textContent = money(data.grandTotals.willOwe);

  renderFilterOptions(el("filter-pc"), data.filterOptions.pcNames, currentFilters.pcName);
  renderFilterOptions(el("filter-state"), data.filterOptions.states, currentFilters.state);
  renderFilterOptions(el("filter-insurance"), data.filterOptions.insurances, currentFilters.insurance);

  const container = el("db-groups");
  container.innerHTML = data.clients.length
    ? data.clients.map(clientBlock).join("")
    : '<p class="db-empty">Nothing matches these filters.</p>';
  wireEdits(container);
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
      container.innerHTML = '<p class="db-empty">No dated enrollments yet.</p>';
      return;
    }
    const max = Math.max(...months.map((m) => m.total));
    container.innerHTML = months
      .map((m) => {
        const h = max > 0 ? Math.max(4, (m.total / max) * 110) : 4;
        const pct = m.growthPct;
        const pctHtml = pct === null ? "" :
          `<span class="db-growth-pct ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}%</span>`;
        return `<div class="db-growth-bar-wrap">
            <span class="db-growth-value">${money(m.total)}</span>
            ${pctHtml}
            <div class="db-growth-bar" style="height:${h}px"></div>
            <span class="db-growth-month">${monthLabel(m.month)}</span>
          </div>`;
      })
      .join("");
  } catch (err) {
    container.innerHTML = `<p class="db-empty">Could not load growth: ${err.message}</p>`;
  }
}

function describeSchedule(status, resultText) {
  const next = status.nextRunAt ? new Date(status.nextRunAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "on next start";
  const last = status.lastRunAt
    ? `${new Date(status.lastRunAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} — ${resultText(status.lastResult)}`
    : "never run";
  return `last ${last} · next ${next}`;
}

async function loadSyncStatus() {
  try {
    const s = await api("/api/quickbooks/schedule-status");
    el("invoice-sync-status-text").textContent =
      "Invoices to QuickBooks: " + describeSchedule(s.invoiceSync, (r) => `${r?.succeeded ?? 0} sent`);
    el("payment-check-status-text").textContent =
      "Payments from QuickBooks: " + describeSchedule(s.paymentCheck, (r) => `${r?.newlyPaid?.length ?? 0} newly paid`);
  } catch {
    el("invoice-sync-status-text").textContent = "Could not load sync schedule.";
    el("payment-check-status-text").textContent = "";
  }
}

async function loadQbStatus() {
  const statusEl = el("qb-status");
  try {
    const s = await api("/auth/quickbooks/status");
    if (s.connected) {
      statusEl.textContent = "QuickBooks connected";
      statusEl.className = "qb-status connected";
    } else {
      statusEl.innerHTML = 'QuickBooks disconnected <a href="/auth/quickbooks">Reconnect</a>';
      statusEl.className = "qb-status disconnected";
    }
  } catch {
    statusEl.textContent = "QuickBooks status unknown";
  }
}

function busy(btn, label, fn) {
  return async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try {
      await fn();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };
}

function init() {
  loadQbStatus();
  loadSyncStatus();
  loadDashboard();
  loadGrowth();

  const filterMap = { "filter-pc": "pcName", "filter-state": "state", "filter-insurance": "insurance" };
  for (const [id, key] of Object.entries(filterMap)) {
    el(id).addEventListener("change", (e) => {
      currentFilters[key] = e.target.value;
      loadDashboard();
    });
  }

  el("clear-filters-btn").addEventListener("click", () => {
    currentFilters = { pcName: "", state: "", insurance: "" };
    loadDashboard();
  });

  const payBtn = el("check-payments-btn");
  payBtn.addEventListener("click", busy(payBtn, "Checking…", async () => {
    const r = await api("/api/quickbooks/refresh-all-payments", { method: "POST" });
    alert(`Checked ${r.invoicesChecked} invoices.\n${r.newlyPaid.length} newly marked paid.`);
    await Promise.all([loadSyncStatus(), loadDashboard()]);
  }));

  const syncBtn = el("sync-now-btn");
  syncBtn.addEventListener("click", busy(syncBtn, "Sending…", async () => {
    const r = await api("/api/quickbooks/batch-sync", { method: "POST", body: JSON.stringify({}) });
    alert(`${r.succeeded} invoices sent to QuickBooks.\n${r.failed} failed.`);
    await Promise.all([loadSyncStatus(), loadDashboard()]);
  }));
}

init();
