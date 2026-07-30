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

// QuickBooks is the sole authority on payment status: "Paid" means a QuickBooks invoice
// has a zero balance, "Sent" means we created the invoice. ClickUp's Deposit Paid /
// Full Amount Paid checkboxes are deliberately NOT used — they're manually maintained
// and were found to disagree with QuickBooks. Imported tasks therefore start unbilled
// and only move once the QuickBooks sync says so.
function derivePaymentStatus(existingStatus) {
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

// The team marks the group/entity-level task by prefixing its name with "*", labelling
// it "Group-", or naming it after the practice entity itself — as opposed to an
// individual provider's name.
function isEntityRow(task) {
  const name = (task.providerName || "").trim();
  if (name.startsWith("*")) return true;
  if (/\bgroup\b/i.test(name)) return true;
  const pc = (task.pcName || "").trim().toLowerCase();
  return pc.length > 0 && name.toLowerCase().includes(pc);
}

// Pricing rules (confirmed with the team):
//
//  * Group-level enrollment: $1,200 per (PC, payer) pair, covering the first 3 providers.
//    Exactly ONE of these may exist per group — a second $1,200 in the same group is a
//    duplicate (same enrollment logged twice) and must not be billed again.
//  * Per-provider charges ($275 for providers beyond the included 3) are a SEPARATE
//    thing from the group fee — both can legitimately appear in the same group.
//  * When a ClickUp task carries its own "Full Amount", that's the real negotiated
//    number and wins over the formula. "Deposit Amount" likewise is used verbatim even
//    when it isn't a 50/50 split; the deposit only falls back to half when it's unset.
function priceGroup(tasksInGroup) {
  const providerOrder = [];
  for (const t of tasksInGroup) {
    if (!providerOrder.includes(t.providerName)) providerOrder.push(t.providerName);
  }

  const priced = tasksInGroup.map((t) => {
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

  // Collapse duplicate group-level enrollments: a single enrollment logged on several
  // tasks must only be billed once. The surviving charge goes on whichever task the team
  // marked as the entity/group row — they prefix those with "*" or name them "Group-" —
  // so the invoice references the group rather than an arbitrary individual provider.
  const groupFeeTasks = priced.filter((t) => t.totalFee === PAYER_ENROLLMENT_RATE);
  if (groupFeeTasks.length > 1) {
    const keeper = groupFeeTasks.find(isEntityRow) || groupFeeTasks[0];
    for (const t of groupFeeTasks) {
      if (t === keeper) continue;
      t.totalFee = 0;
      t.depositDue = 0;
      t.balanceDue = 0;
      t.duplicateGroupFee = true;
    }
  }

  return priced;
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
    const depositPaymentStatus = derivePaymentStatus(null);
    const balancePaymentStatus = derivePaymentStatus(null);

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

// Lists in the Commercial Enrollments folder that aren't real client books of business.
const NON_CLIENT_LISTS = new Set([
  "901327697483", // ***PORTAL ACCSESS***
  "901321880743", // +++State Licensing +++
  "901321880461", // NJ GOV Medicaid — wrong program type for this folder
]);

const ENROLLMENTS_SPACE_ID = process.env.CLICKUP_ENROLLMENTS_SPACE_ID || "901310005602";
const COMMERCIAL_FOLDER_NAME = process.env.CLICKUP_COMMERCIAL_FOLDER || "Commercial Enrollments";

const clientNameFromList = (listName) =>
  listName.replace(/\s*-\s*commercial\s*$/i, "").replace(/\s+commercial\s*$/i, "").trim();

// Discovers every real client list in the Commercial Enrollments folder and imports it.
// Idempotent — already-imported tasks are skipped — so this is safe to run on a schedule.
async function importAllCommercial({ onProgress = null } = {}) {
  const folders = await clickup.getFolders(ENROLLMENTS_SPACE_ID);
  const folder = folders.folders.find((f) => f.name === COMMERCIAL_FOLDER_NAME);
  if (!folder) throw new Error(`ClickUp folder "${COMMERCIAL_FOLDER_NAME}" not found`);

  const lists = folder.lists.filter((l) => l.task_count > 0 && !NON_CLIENT_LISTS.has(l.id));
  const results = { lists: lists.length, imported: 0, skippedExisting: 0, failures: [] };

  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    try {
      const r = await importCommercialList(list.id, clientNameFromList(list.name));
      results.imported += r.imported;
      results.skippedExisting += r.skippedExisting;
    } catch (err) {
      results.failures.push({ list: list.name, message: err.message });
    }
    if (onProgress) onProgress(i + 1, lists.length, list.name);
    // Brief pause between lists so a small instance can reclaim memory between the
    // large per-list payloads rather than accumulating them back to back.
    await new Promise((r) => setTimeout(r, 250));
  }

  return results;
}

module.exports = {
  importCommercialList,
  importAllCommercial,
  STATUS_MAP,
  BALANCE_BILLABLE_STATUSES,
  PAYER_ENROLLMENT_RATE,
  ADDITIONAL_PROVIDER_RATE,
  INCLUDED_PROVIDERS,
  derivePaymentStatus,
  extractField,
};
