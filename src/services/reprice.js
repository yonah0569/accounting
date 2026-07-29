const db = require("../db");

const PAYER_ENROLLMENT_RATE = 1200;

// The team marks the group/entity-level task by prefixing its name with "*", labelling
// it "Group-", or naming it after the practice entity — as opposed to an individual
// provider's name.
function isEntityRow(providerName, pcName) {
  const name = (providerName || "").trim();
  if (name.startsWith("*")) return true;
  if (/\bgroup\b/i.test(name)) return true;
  const pc = (pcName || "").trim().toLowerCase();
  return pc.length > 0 && name.toLowerCase().includes(pc);
}

// The $1,200 group enrollment fee is charged ONCE per (PC, payer) — it covers the group,
// not each provider. Because ClickUp splits a single practice across several lists, the
// same (PC, payer) can appear in many lists, so this must be enforced across the WHOLE
// dataset rather than per-list at import time. Any extra $1,200 rows in the same group
// are the same enrollment logged twice and are zeroed; the surviving charge goes on the
// entity row so the invoice references the group.
//
// Per-provider charges (e.g. $275) are a separate thing and are never touched here.
function repriceDuplicateGroupFees({ dryRun = false } = {}) {
  const rows = db.prepare(`
    SELECT t.id, t.provider_name, t.total_fee, t.deposit_due, t.balance_due,
           t.qb_deposit_invoice_id, t.qb_balance_invoice_id,
           c.name AS pc_name, t.payer_name
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.source = 'clickup_import' AND t.total_fee = ${PAYER_ENROLLMENT_RATE}
    ORDER BY t.id
  `).all();

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.pc_name}::${r.payer_name || "(none)"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const toZero = [];
  for (const [, tasks] of groups) {
    if (tasks.length < 2) continue;
    const keeper = tasks.find((t) => isEntityRow(t.provider_name, t.pc_name)) || tasks[0];
    for (const t of tasks) if (t.id !== keeper.id) toZero.push(t);
  }

  if (!dryRun) {
    const stmt = db.prepare(`
      UPDATE tasks SET total_fee = 0, deposit_due = 0, balance_due = 0, updated_at = datetime('now')
      WHERE id = ?
    `);
    const tx = db.transaction((list) => { for (const t of list) stmt.run(t.id); });
    tx(toZero);
  }

  return {
    groupsChecked: groups.size,
    tasksZeroed: toZero.length,
    dollarsRemoved: toZero.length * PAYER_ENROLLMENT_RATE,
    // invoices that now bill for a $0 task and must be voided
    staleInvoices: toZero.flatMap((t) => [t.qb_deposit_invoice_id, t.qb_balance_invoice_id].filter(Boolean)),
    zeroedTaskIds: toZero.map((t) => t.id),
  };
}

// The same provider, with the same payer, in the same state, should only be charged once.
// ClickUp sometimes holds the same enrollment on more than one task (re-entry, a task
// split across lists), which would otherwise bill the provider twice. The highest-value
// task keeps the charge; the rest are zeroed and marked so the dashboard can show what
// was collapsed — the amount stays editable if a repeat charge is genuinely correct.
function repriceDuplicateProviders({ dryRun = false } = {}) {
  const rows = db.prepare(`
    SELECT t.id, t.provider_name, t.total_fee, t.payer_name,
           t.qb_deposit_invoice_id, t.qb_balance_invoice_id,
           json_extract(t.assigned_states_json, '$[0]') AS state,
           c.name AS pc_name
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.source = 'clickup_import' AND t.total_fee > 0
    ORDER BY t.total_fee DESC, t.id
  `).all();

  const groups = new Map();
  for (const r of rows) {
    const provider = (r.provider_name || "").trim().toLowerCase();
    const key = `${r.pc_name}::${r.payer_name || "-"}::${r.state || "-"}::${provider}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const toZero = [];
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    for (const t of list.slice(1)) toZero.push(t); // list is fee-desc, so [0] is the keeper
  }

  if (!dryRun) {
    const stmt = db.prepare(`
      UPDATE tasks SET total_fee = 0, deposit_due = 0, balance_due = 0,
        duplicate_of_task_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const tx = db.transaction((list) => {
      for (const t of list) {
        const keeper = groups.get(
          `${t.pc_name}::${t.payer_name || "-"}::${t.state || "-"}::${(t.provider_name || "").trim().toLowerCase()}`
        )[0];
        stmt.run(keeper.id, t.id);
      }
    });
    tx(toZero);
  }

  return {
    duplicateGroups: [...groups.values()].filter((l) => l.length > 1).length,
    tasksZeroed: toZero.length,
    dollarsRemoved: toZero.reduce((s, t) => s + t.total_fee, 0),
    staleInvoices: toZero.flatMap((t) => [t.qb_deposit_invoice_id, t.qb_balance_invoice_id].filter(Boolean)),
  };
}

module.exports = { repriceDuplicateGroupFees, repriceDuplicateProviders, isEntityRow, PAYER_ENROLLMENT_RATE };
