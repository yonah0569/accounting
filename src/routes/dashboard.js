const express = require("express");
const db = require("../db");

const router = express.Router();

// total is always the task's true total_fee. paid/owedNow are what's actually been
// invoiced+paid or invoiced+unpaid; willOwe is everything else still outstanding —
// including a balance that hasn't become billable yet (status not active/approved).
// By construction paid + owedNow + willOwe === total.
function taskAmounts(t) {
  const paid =
    (t.deposit_payment_status === "Paid" ? t.deposit_due : 0) +
    (t.balance_billable && t.balance_payment_status === "Paid" ? t.balance_due : 0);
  const owedNow =
    (t.deposit_payment_status === "Sent" ? t.deposit_due : 0) +
    (t.balance_billable && t.balance_payment_status === "Sent" ? t.balance_due : 0);
  const total = t.total_fee;
  const willOwe = total - paid - owedNow;
  return { paid, owedNow, willOwe, total };
}

router.get("/", (req, res) => {
  const { pcName, state, insurance } = req.query;

  const rows = db.prepare(`
    SELECT t.*, c.name AS client_name
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.source = 'clickup_import'
    ORDER BY c.name, t.provider_name
  `).all();

  const filtered = rows.filter((t) => {
    const taskStates = JSON.parse(t.assigned_states_json);
    if (pcName && t.client_name !== pcName) return false;
    if (state && !taskStates.includes(state)) return false;
    if (insurance && t.payer_name !== insurance) return false;
    return true;
  });

  const clientsMap = new Map();
  for (const t of filtered) {
    if (!clientsMap.has(t.client_name)) {
      clientsMap.set(t.client_name, {
        clientId: t.client_id,
        clientName: t.client_name,
        providers: new Map(),
        paid: 0,
        owedNow: 0,
        willOwe: 0,
        total: 0,
      });
    }
    const clientBucket = clientsMap.get(t.client_name);
    const amounts = taskAmounts(t);
    clientBucket.paid += amounts.paid;
    clientBucket.owedNow += amounts.owedNow;
    clientBucket.willOwe += amounts.willOwe;
    clientBucket.total += amounts.total;

    if (!clientBucket.providers.has(t.provider_name)) {
      clientBucket.providers.set(t.provider_name, []);
    }
    clientBucket.providers.get(t.provider_name).push({
      id: t.id,
      payerName: t.payer_name,
      state: JSON.parse(t.assigned_states_json)[0] || null,
      status: t.status,
      clickupStatus: t.clickup_status,
      clickupTaskUrl: t.clickup_task_url,
      totalFee: t.total_fee,
      depositDue: t.deposit_due,
      balanceDue: t.balance_due,
      balanceBillable: !!t.balance_billable,
      depositPaymentStatus: t.deposit_payment_status,
      balancePaymentStatus: t.balance_payment_status,
      qbDepositInvoiceId: t.qb_deposit_invoice_id,
      qbBalanceInvoiceId: t.qb_balance_invoice_id,
      ...amounts,
    });
  }

  const clients = [...clientsMap.values()].map((c) => ({
    ...c,
    providers: [...c.providers.entries()].map(([providerName, tasks]) => ({ providerName, tasks })),
  }));

  const allImported = db.prepare(`
    SELECT t.payer_name, t.assigned_states_json, c.name AS client_name
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.source = 'clickup_import'
  `).all();
  const pcNames = [...new Set(allImported.map((t) => t.client_name))].sort();
  const insurances = [...new Set(allImported.map((t) => t.payer_name).filter(Boolean))].sort();
  const states = [...new Set(allImported.flatMap((t) => JSON.parse(t.assigned_states_json)))].sort();

  const grandTotals = clients.reduce(
    (acc, c) => ({
      paid: acc.paid + c.paid,
      owedNow: acc.owedNow + c.owedNow,
      willOwe: acc.willOwe + c.willOwe,
      total: acc.total + c.total,
    }),
    { paid: 0, owedNow: 0, willOwe: 0, total: 0 }
  );

  res.json({ clients, filterOptions: { pcNames, states, insurances }, grandTotals });
});

// Monthly growth: total value of enrollments by the month the ClickUp task was
// actually created (not when we happened to import it), plus a running cumulative total.
router.get("/growth", (req, res) => {
  const rows = db.prepare(`
    SELECT total_fee, clickup_date_created
    FROM tasks
    WHERE source = 'clickup_import' AND clickup_date_created IS NOT NULL
  `).all();

  const byMonth = new Map();
  for (const r of rows) {
    const month = r.clickup_date_created.slice(0, 7); // YYYY-MM
    if (!byMonth.has(month)) byMonth.set(month, { month, total: 0, count: 0 });
    const bucket = byMonth.get(month);
    bucket.total += r.total_fee;
    bucket.count += 1;
  }

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  let cumulative = 0;
  for (const m of months) {
    cumulative += m.total;
    m.cumulative = cumulative;
    m.growthPct = null;
  }
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1].total;
    months[i].growthPct = prev > 0 ? ((months[i].total - prev) / prev) * 100 : null;
  }

  res.json({ months });
});

module.exports = router;
