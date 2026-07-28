const clickup = require("./clickup");
const db = require("../db");

const PAYER_ENROLLMENT_RATE = 1200; // covers the first 3 providers under one (PC, payer) pair
const ADDITIONAL_PROVIDER_RATE = 275; // each provider beyond the first 3, same (PC, payer) pair
const INCLUDED_PROVIDERS = 3;

// Real ClickUp status text -> our local status enum. "app denied"/"canceled" are
// terminal-negative: work may have started (deposit still applies) but never completed.
const STATUS_MAP = {
  "new pending req": "Not Started",
  "new approved req": "Not Started",
  "prep app": "In Progress",
  "pend grp": "In Progress",
  "pend client": "In Progress",
  "int rev to submit": "In Progress",
  "approved to submit": "Submitted",
  "pend payer": "Submitted",
  "pend payer - resubmitted": "Submitted",
  "app returned": "Submitted",
  "contract received": "Approved",
  "app approved": "Approved",
  active: "Active",
  "app denied": "Denied",
  canceled: "Canceled",
};

const BALANCE_BILLABLE_STATUSES = new Set(["app approved", "active"]);

// ClickUp's Deposit Paid / Full Amount Paid flags are the real, manually-tracked ground
// truth for what's actually been collected — they win over anything else. Sent status
// never gets downgraded once set (e.g. by us creating a QuickBooks invoice).
function derivePaymentStatus(clickupPaid, clickupSent, existingStatus) {
  if (clickupPaid) return "Paid";
  if (existingStatus === "Paid" || existingStatus === "Sent") return existingStatus;
  if (clickupSent) return "Sent";
  return existingStatus || "Not Sent";
}

function extractField(task, name) {
  const field = task.custom_fields.find((f) => f.name === name);
  if (!field || field.value === null || field.value === undefined || field.value === "") return null;
  if (field.type === "drop_down") {
    const opt = field.type_config.options.find((o) => o.orderindex === field.value);
    return opt ? opt.name.trim() : null;
  }
  return field.value;
}

const clientCache = new Map();
function getOrCreateClient(name) {
  if (clientCache.has(name)) return clientCache.get(name);
  const existing = db.prepare("SELECT * FROM clients WHERE name = ?").get(name);
  const client = existing || (() => {
    const info = db.prepare("INSERT INTO clients (name) VALUES (?)").run(name);
    return db.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid);
  })();
  clientCache.set(name, client);
  return client;
}

// Pricing rule (confirmed): $1,200 per (PC, payer) pair covers the first 3 distinct
// providers enrolled with that payer as ONE enrollment fee, charged against the first
// provider in the group. Providers 4+ under that same (PC, payer) each cost $275
// individually. Providers 2-3 ride along at $0 (already covered by the group fee).
//
// EXCEPTION (confirmed): when the real ClickUp task already has a "Full Amount" entered
// by the team, that's authoritative and overrides the formula — it's an already-determined
// real amount, not derived. "Deposit Amount" likewise overrides the 50/50 split when set;
// otherwise the deposit defaults to half of whatever the final total is.
function priceGroup(tasksInGroup) {
  const providerOrder = [];
  for (const t of tasksInGroup) {
    if (!providerOrder.includes(t.providerName)) providerOrder.push(t.providerName);
  }

  return tasksInGroup.map((t) => {
    const rank = providerOrder.indexOf(t.providerName);
    let totalFee;
    if (rank === 0) totalFee = PAYER_ENROLLMENT_RATE;
    else if (rank < INCLUDED_PROVIDERS) totalFee = 0;
    else totalFee = ADDITIONAL_PROVIDER_RATE;
    let depositDue = totalFee / 2;
    let balanceDue = totalFee / 2;

    if (t.clickupFullAmount > 0) {
      totalFee = t.clickupFullAmount;
      depositDue = t.clickupDepositAmount > 0 ? t.clickupDepositAmount : totalFee / 2;
      balanceDue = totalFee - depositDue;
    }

    return { ...t, totalFee, depositDue, balanceDue, providerRank: rank };
  });
}

// Imports every task from a ClickUp Commercial Enrollment list as a local task row.
// Client identity is the task's "PC Name" custom field (one PC = one billable client).
// Pricing is computed per (PC, payer) group per priceGroup() above, not per task.
// Idempotent (matched by clickup_task_id) and read-only against ClickUp.
async function importCommercialList(listId, fallbackClientName, { dryRun = false } = {}) {
  const clickupTasks = await clickup.getAllListTasks(listId);
  clientCache.clear();

  const extracted = clickupTasks.map((task) => {
    const rawStatus = task.status.status.toLowerCase();
    return {
      task,
      clickupTaskId: task.id,
      clickupTaskUrl: task.url,
      clickupDateCreated: task.date_created ? new Date(Number(task.date_created)).toISOString() : null,
      pcName: extractField(task, "PC Name") || fallbackClientName,
      providerName: task.name,
      payerName: extractField(task, "Insurance"),
      state: extractField(task, "State"),
      clickupStatus: task.status.status,
      localStatus: STATUS_MAP[rawStatus] || "Not Started",
      balanceBillable: BALANCE_BILLABLE_STATUSES.has(rawStatus),
      clickupFullAmount: Number(extractField(task, "Full Amount")) || 0,
      clickupDepositAmount: Number(extractField(task, "Deposit Amount")) || 0,
      clickupDepositSent: extractField(task, "Deposist Sent (Enrollments)") === "Yes",
      clickupDepositPaid: extractField(task, "Deposit Paid") === "Yes",
      clickupFullSent: extractField(task, "Full Invoice Sent") === "Yes",
      clickupFullPaid: extractField(task, "Full Amount Paid") === "Yes",
    };
  });

  const groups = new Map();
  for (const row of extracted) {
    const key = `${row.pcName}::${row.payerName || "(no payer)"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const priced = [...groups.values()].flatMap(priceGroup);

  const results = { total: priced.length, imported: 0, skippedExisting: 0, rows: [] };

  for (const row of priced) {
    if (dryRun) {
      results.rows.push(row);
      continue;
    }

    const existing = db.prepare("SELECT id FROM tasks WHERE clickup_task_id = ?").get(row.clickupTaskId);
    if (existing) {
      results.skippedExisting += 1;
      continue;
    }

    const client = getOrCreateClient(row.pcName);
    const depositPaymentStatus = derivePaymentStatus(row.clickupDepositPaid, row.clickupDepositSent, null);
    const balancePaymentStatus = derivePaymentStatus(row.clickupFullPaid, row.clickupFullSent, null);

    db.prepare(`
      INSERT INTO tasks (
        client_id, services_json, additional_providers, assigned_states_json, notes, status,
        total_fee, deposit_due, balance_due, source, provider_name, payer_name,
        clickup_status, clickup_list_id, clickup_list_name, clickup_task_id, clickup_task_url,
        balance_billable, clickup_date_created, deposit_payment_status, balance_payment_status
      ) VALUES (?, ?, 0, ?, NULL, ?, ?, ?, ?, 'clickup_import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      client.id,
      JSON.stringify([{ type: "commercialEnrollment", payers: 1 }]),
      JSON.stringify(row.state ? [row.state] : []),
      row.localStatus,
      row.totalFee,
      row.depositDue,
      row.balanceDue,
      row.providerName,
      row.payerName,
      row.clickupStatus,
      listId,
      row.pcName,
      row.clickupTaskId,
      row.clickupTaskUrl,
      row.balanceBillable ? 1 : 0,
      row.clickupDateCreated,
      depositPaymentStatus,
      balancePaymentStatus
    );
    results.imported += 1;
    results.rows.push(row);
  }

  return results;
}

module.exports = {
  importCommercialList,
  STATUS_MAP,
  BALANCE_BILLABLE_STATUSES,
  PAYER_ENROLLMENT_RATE,
  ADDITIONAL_PROVIDER_RATE,
  INCLUDED_PROVIDERS,
  derivePaymentStatus,
  extractField,
};
