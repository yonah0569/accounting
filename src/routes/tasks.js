const express = require("express");
const db = require("../db");
const { calculateTask } = require("../services/pricing");
const { syncTaskToClickUp, updateClickUpStatusFields } = require("../services/clickupSync");

const router = express.Router();

const TASK_STATUSES = ["Not Started", "In Progress", "Submitted", "Approved", "Active", "Paid", "Denied", "Canceled"];
const PAYMENT_STATUSES = ["Not Sent", "Sent", "Paid"];

function serializeTask(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    services: JSON.parse(row.services_json),
    additionalProviders: row.additional_providers,
    assignedStates: JSON.parse(row.assigned_states_json),
    notes: row.notes,
    status: row.status,
    totalFee: row.total_fee,
    depositDue: row.deposit_due,
    balanceDue: row.balance_due,
    depositPaymentStatus: row.deposit_payment_status,
    balancePaymentStatus: row.balance_payment_status,
    clickupTaskId: row.clickup_task_id,
    clickupTaskUrl: row.clickup_task_url,
    qbDepositInvoiceId: row.qb_deposit_invoice_id,
    qbBalanceInvoiceId: row.qb_balance_invoice_id,
    syncErrors: JSON.parse(row.sync_errors_json),
    source: row.source,
    providerName: row.provider_name,
    payerName: row.payer_name,
    clickupStatus: row.clickup_status,
    clickupListName: row.clickup_list_name,
    balanceBillable: !!row.balance_billable,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getClientOrThrow(clientId) {
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(clientId);
  if (!client) {
    const err = new Error("Client not found");
    err.status = 400;
    throw err;
  }
  return client;
}

// Stateless preview: used by the form's live-updating financial summary panel,
// and by "Preview QB Invoice" — no DB write.
router.post("/calculate", (req, res) => {
  try {
    const { clientId, services, additionalProviders } = req.body;
    let rateOverrides = {};
    if (clientId) {
      const client = getClientOrThrow(clientId);
      rateOverrides = JSON.parse(client.rate_overrides_json);
    }
    const result = calculateTask({ services, additionalProviders }, rateOverrides);
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
  res.json(rows.map(serializeTask));
});

router.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Task not found" });
  res.json(serializeTask(row));
});

router.post("/", (req, res) => {
  const { clientId, services, additionalProviders, assignedStates, notes } = req.body;
  try {
    const client = getClientOrThrow(clientId);
    const rateOverrides = JSON.parse(client.rate_overrides_json);
    const result = calculateTask({ services, additionalProviders }, rateOverrides);

    const stmt = db.prepare(`
      INSERT INTO tasks (
        client_id, services_json, additional_providers, assigned_states_json,
        notes, total_fee, deposit_due, balance_due, balance_billable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const info = stmt.run(
      client.id,
      JSON.stringify(services || []),
      Math.max(0, Number(additionalProviders) || 0),
      JSON.stringify(assignedStates || []),
      notes || null,
      result.totalFee,
      result.depositDue,
      result.balanceDue
    );
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json(serializeTask(row));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Task not found" });

  const { status, depositPaymentStatus, balancePaymentStatus, notes, totalFee, depositDue, balanceDue, balanceBillable } = req.body;
  if (status && !TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${TASK_STATUSES.join(", ")}` });
  }
  if (depositPaymentStatus && !PAYMENT_STATUSES.includes(depositPaymentStatus)) {
    return res.status(400).json({ error: `depositPaymentStatus must be one of ${PAYMENT_STATUSES.join(", ")}` });
  }
  if (balancePaymentStatus && !PAYMENT_STATUSES.includes(balancePaymentStatus)) {
    return res.status(400).json({ error: `balancePaymentStatus must be one of ${PAYMENT_STATUSES.join(", ")}` });
  }
  for (const [key, val] of Object.entries({ totalFee, depositDue, balanceDue })) {
    if (val !== undefined && (typeof val !== "number" || val < 0)) {
      return res.status(400).json({ error: `${key} must be a non-negative number` });
    }
  }

  db.prepare(`
    UPDATE tasks SET
      status = COALESCE(?, status),
      deposit_payment_status = COALESCE(?, deposit_payment_status),
      balance_payment_status = COALESCE(?, balance_payment_status),
      notes = COALESCE(?, notes),
      total_fee = COALESCE(?, total_fee),
      deposit_due = COALESCE(?, deposit_due),
      balance_due = COALESCE(?, balance_due),
      balance_billable = COALESCE(?, balance_billable),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    status,
    depositPaymentStatus,
    balancePaymentStatus,
    notes,
    totalFee,
    depositDue,
    balanceDue,
    balanceBillable === undefined ? null : (balanceBillable ? 1 : 0),
    req.params.id
  );

  let row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);

  // Push status/payment changes to the linked ClickUp task, best-effort — a sync
  // failure here shouldn't block the status update the user just made.
  if (row.clickup_task_id && row.source !== "clickup_import" && (status || depositPaymentStatus || balancePaymentStatus)) {
    try {
      await updateClickUpStatusFields(row.clickup_task_id, { status, depositPaymentStatus, balancePaymentStatus });
    } catch (err) {
      const errors = JSON.parse(row.sync_errors_json);
      errors.push({ at: new Date().toISOString(), target: "clickup", message: err.message });
      db.prepare("UPDATE tasks SET sync_errors_json = ? WHERE id = ?").run(JSON.stringify(errors), req.params.id);
      row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    }
  }

  res.json(serializeTask(row));
});

// Creates (or re-creates) the linked ClickUp task and writes back its ID/URL.
router.post("/:id/sync-clickup", async (req, res) => {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Task not found" });
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(row.client_id);

  try {
    const task = serializeTask(row);
    const rateOverrides = JSON.parse(client.rate_overrides_json);
    const { lineItems } = calculateTask({ services: task.services, additionalProviders: task.additionalProviders }, rateOverrides);

    const { taskId, url } = await syncTaskToClickUp(task, client, lineItems);

    db.prepare("UPDATE tasks SET clickup_task_id = ?, clickup_task_url = ?, updated_at = datetime('now') WHERE id = ?").run(
      taskId,
      url,
      req.params.id
    );
    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    res.json(serializeTask(updated));
  } catch (err) {
    const errors = JSON.parse(row.sync_errors_json);
    errors.push({ at: new Date().toISOString(), target: "clickup", message: err.message });
    db.prepare("UPDATE tasks SET sync_errors_json = ? WHERE id = ?").run(JSON.stringify(errors), req.params.id);
    res.status(err.status || 502).json({ error: err.message });
  }
});

module.exports = router;
