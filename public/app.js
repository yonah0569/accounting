const SERVICE_DEFS = [
  { type: "commercialEnrollment", label: "Commercial Enrollment", qtyFields: [{ key: "payers", label: "# Payers", rateKey: "commercialEnrollment" }] },
  { type: "medicaid", label: "Medicaid", qtyFields: [{ key: "states", label: "# States", rateKey: "medicaid" }] },
  { type: "medicarePecos", label: "Medicare/PECOS", qtyFields: [{ key: "states", label: "# States", rateKey: "medicarePecos" }] },
  { type: "recredentialing", label: "Recredentialing", qtyFields: [{ key: "payers", label: "# Payers", rateKey: "recredentialing" }, { key: "providers", label: "# Providers", rateKey: "recredentialing" }] },
  { type: "caqh", label: "CAQH", qtyFields: [], rateKey: "caqh" },
  { type: "eftEdi", label: "EFT/EDI", qtyFields: [], rateKey: "eftEdi" },
  { type: "npi", label: "NPI", qtyFields: [], rateKey: "npi" },
  {
    type: "license", label: "License", qtyFields: [],
    licenseSelect: [
      { value: "rn", label: "RN License", rateKey: "rnLicense" },
      { value: "np", label: "NP / New Professional License", rateKey: "npLicense" },
      { value: "renewal", label: "License Renewal", rateKey: "licenseRenewal" },
    ],
  },
  { type: "demographicUpdate", label: "Demographic Update", qtyFields: [], rateKey: "demographicUpdate" },
];

const RATE_LABELS = {
  commercialEnrollment: "Commercial Enrollment ($/payer)",
  medicaid: "Medicaid ($/state)",
  medicarePecos: "Medicare/PECOS ($/state)",
  recredentialing: "Recredentialing ($/payer/provider)",
  caqh: "CAQH (flat)",
  eftEdi: "EFT/EDI (flat)",
  npi: "NPI (flat)",
  rnLicense: "RN License (flat)",
  npLicense: "NP/New License (flat)",
  licenseRenewal: "License Renewal (flat)",
  demographicUpdate: "Demographic Update (flat)",
  additionalProvider: "Additional Provider (each)",
};

let standardRates = {};
let clients = [];
let tasks = [];

const el = (id) => document.getElementById(id);
const money = (n) => `$${Number(n).toFixed(2)}`;

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function buildServiceChecklist() {
  const container = el("service-checkboxes");
  container.innerHTML = "";
  for (const def of SERVICE_DEFS) {
    const item = document.createElement("div");
    item.className = "service-item";
    item.dataset.type = def.type;

    const header = document.createElement("div");
    header.className = "service-item-header";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "service-enable";
    checkbox.id = `svc-${def.type}`;
    const label = document.createElement("label");
    label.htmlFor = checkbox.id;
    label.textContent = def.label;
    header.append(checkbox, label);
    item.append(header);

    const qtyRow = document.createElement("div");
    qtyRow.className = "service-item-qty hidden";

    if (def.licenseSelect) {
      const wrap = document.createElement("label");
      wrap.textContent = "Type";
      const select = document.createElement("select");
      select.className = "svc-field";
      select.dataset.key = "licenseType";
      for (const opt of def.licenseSelect) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        select.append(o);
      }
      wrap.append(select);
      qtyRow.append(wrap);
    }

    for (const qf of def.qtyFields) {
      const wrap = document.createElement("label");
      wrap.textContent = qf.label;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.value = "1";
      input.className = "svc-field";
      input.dataset.key = qf.key;
      wrap.append(input);
      qtyRow.append(wrap);
    }

    item.append(qtyRow);
    container.append(item);

    checkbox.addEventListener("change", () => {
      qtyRow.classList.toggle("hidden", !checkbox.checked);
      recalculate();
    });
    qtyRow.querySelectorAll(".svc-field").forEach((f) => f.addEventListener("input", recalculate));
  }
}

function collectServices() {
  const services = [];
  document.querySelectorAll(".service-item").forEach((item) => {
    const checkbox = item.querySelector(".service-enable");
    if (!checkbox.checked) return;
    const service = { type: item.dataset.type };
    item.querySelectorAll(".svc-field").forEach((f) => {
      const val = f.tagName === "SELECT" ? f.value : Number(f.value) || 0;
      service[f.dataset.key] = val;
    });
    services.push(service);
  });
  return services;
}

function currentClientId() {
  const val = el("client-select").value;
  return val ? Number(val) : null;
}

async function recalculate() {
  const services = collectServices();
  const additionalProviders = Number(el("additional-providers").value) || 0;
  const errorEl = el("form-error");
  errorEl.classList.add("hidden");

  try {
    const result = await api("/api/tasks/calculate", {
      method: "POST",
      body: JSON.stringify({ clientId: currentClientId(), services, additionalProviders }),
    });
    renderSummary(result);
    return result;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
    renderSummary({ lineItems: [], totalFee: 0, depositDue: 0, balanceDue: 0 });
    return null;
  }
}

function renderSummary(result) {
  const container = el("line-items");
  container.innerHTML = "";
  if (!result.lineItems.length) {
    container.innerHTML = '<div class="line-items-empty">No services selected yet</div>';
  } else {
    for (const item of result.lineItems) {
      const row = document.createElement("div");
      row.className = "line-item-row";
      row.innerHTML = `<span>${item.label}<div class="detail">${item.detail}</div></span><span>${money(item.subtotal)}</span>`;
      container.append(row);
    }
  }
  el("total-fee").textContent = money(result.totalFee);
  el("deposit-due").textContent = money(result.depositDue);
  el("balance-due").textContent = money(result.balanceDue);
}

function setBadge(elId, status) {
  const badge = el(elId);
  badge.textContent = status;
  badge.className = "badge " + (status === "Paid" ? "badge-paid" : status === "Sent" ? "badge-sent" : "badge-not-sent");
}

async function loadClients() {
  clients = await api("/api/clients");
  const select = el("client-select");
  select.innerHTML = clients.length
    ? clients.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")
    : '<option value="">No clients yet — add one</option>';
}

function buildCustomRateFields() {
  const container = el("custom-rate-fields");
  container.innerHTML = Object.keys(standardRates)
    .map(
      (key) => `
      <label>${RATE_LABELS[key] || key}
        <input type="number" step="0.01" class="rate-override" data-key="${key}" placeholder="${standardRates[key]}" />
      </label>`
    )
    .join("");
}

function wireNewClientForm() {
  el("new-client-btn").addEventListener("click", () => {
    el("new-client-form").classList.remove("hidden");
  });
  el("cancel-client-btn").addEventListener("click", () => {
    el("new-client-form").classList.add("hidden");
    el("new-client-name").value = "";
  });
  el("new-client-custom-pricing").addEventListener("change", (e) => {
    el("custom-rate-fields").classList.toggle("hidden", !e.target.checked);
  });
  el("save-client-btn").addEventListener("click", async () => {
    const name = el("new-client-name").value.trim();
    if (!name) return;
    const rateOverrides = {};
    if (el("new-client-custom-pricing").checked) {
      document.querySelectorAll(".rate-override").forEach((input) => {
        if (input.value !== "") rateOverrides[input.dataset.key] = Number(input.value);
      });
    }
    try {
      const client = await api("/api/clients", { method: "POST", body: JSON.stringify({ name, rateOverrides }) });
      await loadClients();
      el("client-select").value = client.id;
      el("new-client-form").classList.add("hidden");
      el("new-client-name").value = "";
      recalculate();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function loadTasks() {
  tasks = await api("/api/tasks");
  const tbody = document.querySelector("#task-table tbody");
  tbody.innerHTML = tasks
    .map((t) => {
      const client = clients.find((c) => c.id === t.clientId);
      const clickup = t.clickupTaskUrl
        ? `<a href="${t.clickupTaskUrl}" target="_blank" rel="noopener">Open</a>`
        : t.syncErrors.some((e) => e.target === "clickup")
        ? `<span class="error" title="${[...t.syncErrors].reverse().find((e) => e.target === "clickup").message}">Sync failed</span>`
        : "—";

      let qb;
      if (t.qbDepositInvoiceId && t.qbBalanceInvoiceId) {
        qb = `Dep #${t.qbDepositInvoiceId} / Bal #${t.qbBalanceInvoiceId}
          <button class="row-btn" data-action="refresh-qb" data-id="${t.id}">Refresh Payment</button>`;
      } else if (t.syncErrors.some((e) => e.target === "quickbooks")) {
        qb = `<span class="error" title="${[...t.syncErrors].reverse().find((e) => e.target === "quickbooks").message}">Sync failed</span>
          <button class="row-btn" data-action="sync-qb" data-id="${t.id}">Retry</button>`;
      } else {
        qb = `<button class="row-btn" data-action="sync-qb" data-id="${t.id}">Sync to QuickBooks</button>`;
      }

      return `<tr>
        <td>${t.id}</td>
        <td>${client ? client.name : t.clientId}</td>
        <td>${t.status}</td>
        <td>${money(t.totalFee)}</td>
        <td>${money(t.depositDue)}</td>
        <td>${money(t.balanceDue)}</td>
        <td>${t.depositPaymentStatus}</td>
        <td>${t.balancePaymentStatus}</td>
        <td>${clickup}</td>
        <td>${qb}</td>
      </tr>`;
    })
    .join("");
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
  } catch (err) {
    statusEl.textContent = "Could not check QuickBooks status";
    statusEl.className = "qb-status disconnected";
  }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const taskId = btn.dataset.id;
  btn.disabled = true;
  try {
    if (btn.dataset.action === "sync-qb") {
      await api(`/api/quickbooks/tasks/${taskId}/sync`, { method: "POST" });
    } else if (btn.dataset.action === "refresh-qb") {
      await api(`/api/quickbooks/tasks/${taskId}/refresh-payment-status`, { method: "POST" });
    }
    await loadTasks();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
});

async function createTask() {
  const errorEl = el("form-error");
  errorEl.classList.add("hidden");
  const clientId = currentClientId();
  if (!clientId) {
    errorEl.textContent = "Select or create a client first.";
    errorEl.classList.remove("hidden");
    return;
  }
  const services = collectServices();
  if (!services.length) {
    errorEl.textContent = "Select at least one service type.";
    errorEl.classList.remove("hidden");
    return;
  }
  const payload = {
    clientId,
    services,
    additionalProviders: Number(el("additional-providers").value) || 0,
    assignedStates: el("assigned-states").value.split(",").map((s) => s.trim()).filter(Boolean),
    notes: el("notes").value || null,
  };
  try {
    const created = await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
    await loadTasks();
    el("notes").value = "";
    setBadge("deposit-status", "Not Sent");
    setBadge("balance-status", "Not Sent");

    // Immediately sync the new task to ClickUp, per the spec's create workflow.
    try {
      const synced = await api(`/api/tasks/${created.id}/sync-clickup`, { method: "POST" });
      await loadTasks();
      if (synced.clickupTaskUrl) {
        const link = el("view-clickup-link");
        link.href = synced.clickupTaskUrl;
        link.classList.remove("disabled");
      }
    } catch (syncErr) {
      errorEl.textContent = `Task saved, but ClickUp sync failed: ${syncErr.message}`;
      errorEl.classList.remove("hidden");
    }

    // Immediately sync to QuickBooks too (deposit + balance invoices). If QuickBooks
    // isn't connected yet this fails quietly — the task row shows a retry button.
    try {
      await api(`/api/quickbooks/tasks/${created.id}/sync`, { method: "POST" });
    } catch (qbErr) {
      // surfaced via the task row's "Sync failed / Retry" state, not the top banner
    }
    await loadTasks();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
}

async function previewInvoice() {
  const result = await recalculate();
  if (!result) return;
  const client = clients.find((c) => c.id === currentClientId());
  const lines = result.lineItems.map((li) => `  ${li.label.padEnd(32)} ${li.detail.padEnd(28)} ${money(li.subtotal)}`).join("\n");
  const body = `Invoice #1 — Deposit
Bill To: ${client ? client.name : "(select a client)"}
--------------------------------------------------
${lines}
--------------------------------------------------
Total Fee:    ${money(result.totalFee)}
Deposit Due:  ${money(result.depositDue)}  (50%, non-refundable)

Invoice #2 — Balance (created as draft until deposit is paid)
Balance Due:  ${money(result.balanceDue)}  (50%, due at approval/submission)`;
  el("invoice-preview-body").textContent = body;
  el("invoice-preview-modal").classList.remove("hidden");
}

function init() {
  buildServiceChecklist();
  wireNewClientForm();

  el("client-select").addEventListener("change", recalculate);
  el("additional-providers").addEventListener("input", recalculate);
  el("create-task-btn").addEventListener("click", createTask);
  el("preview-invoice-btn").addEventListener("click", previewInvoice);
  el("close-preview-btn").addEventListener("click", () => el("invoice-preview-modal").classList.add("hidden"));

  loadQbStatus();
  Promise.all([api("/api/rates"), loadClients()])
    .then(([rates]) => {
      standardRates = rates;
      buildCustomRateFields();
      return loadTasks();
    })
    .then(recalculate);
}

init();
