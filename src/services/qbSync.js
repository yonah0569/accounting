const db = require("../db");
const quickbooks = require("./quickbooks");
const { updateClickUpStatusFields } = require("./clickupSync");

function loadTaskAndClient(taskId) {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return { task: null, client: null };
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(task.client_id);
  return { task, client };
}

function logSyncError(taskId, target, message) {
  const row = db.prepare("SELECT sync_errors_json FROM tasks WHERE id = ?").get(taskId);
  const errors = JSON.parse(row.sync_errors_json);
  errors.push({ at: new Date().toISOString(), target, message });
  db.prepare("UPDATE tasks SET sync_errors_json = ? WHERE id = ?").run(JSON.stringify(errors), taskId);
}

// Creates (or reuses) the QB customer, then creates the deposit invoice always, and
// the balance invoice only if the task is marked balance_billable (status reached
// active/approved). Idempotent: skips invoices that already exist for this task.
async function syncTask(taskId) {
  const { task, client } = loadTaskAndClient(taskId);
  if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });

  // $0 tasks are "riders" already covered by another provider's enrollment fee in the
  // same (PC, payer) group — nothing to invoice.
  if (task.total_fee === 0) {
    return { depositInvoiceId: null, balanceInvoiceId: null, skipped: "zero-amount task" };
  }

  const customer = await quickbooks.findOrCreateCustomer(client.name);
  db.prepare("UPDATE clients SET qb_customer_id = ? WHERE id = ?").run(customer.Id, client.id);

  let depositInvoiceId = task.qb_deposit_invoice_id;
  let depositPaymentStatus = task.deposit_payment_status;
  if (!depositInvoiceId) {
    const depositInvoice = await quickbooks.createInvoice({
      customerId: customer.Id,
      itemName: "Credentialing Deposit",
      amount: task.deposit_due,
      memo: `Deposit — Task #${task.id} (non-refundable)`,
      docNumber: `T${task.id}-DEP`,
    });
    depositInvoiceId = depositInvoice.Id;
    depositPaymentStatus = "Sent";
  }

  let balanceInvoiceId = task.qb_balance_invoice_id;
  let balancePaymentStatus = task.balance_payment_status;
  if (!balanceInvoiceId && task.balance_billable) {
    const balanceInvoice = await quickbooks.createInvoice({
      customerId: customer.Id,
      itemName: "Credentialing Balance",
      amount: task.balance_due,
      memo: `Balance Due — Task #${task.id}`,
      docNumber: `T${task.id}-BAL`,
    });
    balanceInvoiceId = balanceInvoice.Id;
    balancePaymentStatus = "Sent";
  }

  db.prepare(`
    UPDATE tasks SET
      qb_deposit_invoice_id = ?, qb_balance_invoice_id = ?,
      deposit_payment_status = ?, balance_payment_status = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(depositInvoiceId, balanceInvoiceId, depositPaymentStatus, balancePaymentStatus, task.id);

  if (task.clickup_task_id && task.source !== "clickup_import") {
    try {
      await updateClickUpStatusFields(task.clickup_task_id, {
        qbDepositInvoiceId: depositInvoiceId,
        qbBalanceInvoiceId: balanceInvoiceId,
      });
    } catch (err) {
      logSyncError(task.id, "clickup", `Failed to write QB invoice IDs back to ClickUp: ${err.message}`);
    }
  }

  return { depositInvoiceId, balanceInvoiceId };
}

async function refreshTaskPaymentStatus(taskId) {
  const { task } = loadTaskAndClient(taskId);
  if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
  if (!task.qb_deposit_invoice_id) {
    throw Object.assign(new Error("This task has not been synced to QuickBooks yet."), { status: 400 });
  }

  const deposit = await quickbooks.getInvoice(task.qb_deposit_invoice_id);
  const depositPaymentStatus = Number(deposit.Balance) <= 0 ? "Paid" : "Sent";

  let balancePaymentStatus = task.balance_payment_status;
  if (task.qb_balance_invoice_id) {
    const balance = await quickbooks.getInvoice(task.qb_balance_invoice_id);
    balancePaymentStatus = Number(balance.Balance) <= 0 ? "Paid" : "Sent";
  }

  db.prepare(`
    UPDATE tasks SET deposit_payment_status = ?, balance_payment_status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(depositPaymentStatus, balancePaymentStatus, task.id);

  if (task.clickup_task_id && task.source !== "clickup_import") {
    try {
      await updateClickUpStatusFields(task.clickup_task_id, { depositPaymentStatus, balancePaymentStatus });
    } catch (err) {
      logSyncError(task.id, "clickup", `Failed to sync payment status to ClickUp: ${err.message}`);
    }
  }

  return { depositPaymentStatus, balancePaymentStatus };
}

// Finds every task that needs a QuickBooks invoice created (new deposit, or a balance
// that just became billable) and syncs them, `concurrency` at a time. This is what the
// biweekly job runs. onProgress(done, total) is optional, for long-running CLI use.
async function runBatchSync({ concurrency = 1, onProgress = null } = {}) {
  const pending = db.prepare(`
    SELECT id FROM tasks
    WHERE total_fee > 0
      AND (
        qb_deposit_invoice_id IS NULL
        OR (balance_billable = 1 AND qb_balance_invoice_id IS NULL)
      )
  `).all();

  const results = { attempted: pending.length, succeeded: 0, failed: 0, errors: [] };
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const { id } = pending[cursor++];
      try {
        await syncTask(id);
        results.succeeded += 1;
      } catch (err) {
        logSyncError(id, "quickbooks", err.message);
        results.failed += 1;
        results.errors.push({ taskId: id, message: err.message });
      }
      if (onProgress) onProgress(results.succeeded + results.failed, pending.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) || 1 }, worker));
  return results;
}

// Pulls the CURRENT balance for every invoice in QuickBooks in bulk (paginated queries,
// not one request per task) and reconciles local payment status against it. This is
// what "did a payment come in?" actually means — QuickBooks is the source of truth for
// Paid, never ClickUp's manual checkboxes. Safe to run often; only writes on change.
async function refreshAllPaymentStatuses() {
  const invoices = new Map();
  let startPosition = 1;
  while (true) {
    const data = await quickbooks.query(
      `select Id, TotalAmt, Balance from Invoice startposition ${startPosition} maxresults 1000`
    );
    const rows = data.QueryResponse?.Invoice || [];
    for (const inv of rows) invoices.set(inv.Id, { totalAmt: inv.TotalAmt, balance: inv.Balance ?? 0 });
    if (rows.length < 1000) break;
    startPosition += 1000;
  }

  const tasks = db.prepare(`
    SELECT id, qb_deposit_invoice_id, qb_balance_invoice_id, clickup_task_id, source,
           deposit_payment_status, balance_payment_status
    FROM tasks WHERE qb_deposit_invoice_id IS NOT NULL
  `).all();

  const updateStmt = db.prepare(`
    UPDATE tasks SET deposit_payment_status = ?, balance_payment_status = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const result = { invoicesChecked: invoices.size, tasksChecked: tasks.length, updated: 0, newlyPaid: [] };

  for (const t of tasks) {
    let newDeposit = t.deposit_payment_status;
    const depInv = invoices.get(t.qb_deposit_invoice_id);
    if (depInv) newDeposit = Number(depInv.balance) <= 0 ? "Paid" : "Sent";

    let newBalance = t.balance_payment_status;
    if (t.qb_balance_invoice_id) {
      const balInv = invoices.get(t.qb_balance_invoice_id);
      if (balInv) newBalance = Number(balInv.balance) <= 0 ? "Paid" : "Sent";
    }

    if (newDeposit === t.deposit_payment_status && newBalance === t.balance_payment_status) continue;

    updateStmt.run(newDeposit, newBalance, t.id);
    result.updated += 1;
    const justPaid = (newDeposit === "Paid" && t.deposit_payment_status !== "Paid") ||
      (newBalance === "Paid" && t.balance_payment_status !== "Paid");
    if (justPaid) result.newlyPaid.push(t.id);

    if (t.clickup_task_id && t.source !== "clickup_import") {
      try {
        await updateClickUpStatusFields(t.clickup_task_id, { depositPaymentStatus: newDeposit, balancePaymentStatus: newBalance });
      } catch (err) {
        logSyncError(t.id, "clickup", `Failed to sync payment status to ClickUp: ${err.message}`);
      }
    }
  }

  return result;
}

module.exports = { syncTask, refreshTaskPaymentStatus, runBatchSync, refreshAllPaymentStatuses, logSyncError };
