const express = require("express");
const db = require("../db");
const { isEntityRow, PAYER_ENROLLMENT_RATE } = require("../services/reprice");

const router = express.Router();

// total is always the task's true total_fee. paid/owedNow are what QuickBooks says has
// been invoiced and settled; willOwe is everything still outstanding — including a
// balance that isn't billable yet. By construction paid + owedNow + willOwe === total.
function taskAmounts(t) {
  const paid =
    (t.deposit_payment_status === "Paid" ? t.deposit_due : 0) +
    (t.balance_billable && t.balance_payment_status === "Paid" ? t.balance_due : 0);
  const owedNow =
    (t.deposit_payment_status === "Sent" ? t.deposit_due : 0) +
    (t.balance_billable && t.balance_payment_status === "Sent" ? t.balance_due : 0);
  const total = t.total_fee;
  return { paid, owedNow, willOwe: total - paid - owedNow, total };
}

const emptyTotals = () => ({ paid: 0, owedNow: 0, willOwe: 0, total: 0 });
function addTotals(target, amounts) {
  target.paid += amounts.paid;
  target.owedNow += amounts.owedNow;
  target.willOwe += amounts.willOwe;
  target.total += amounts.total;
}

// Hierarchy is PC -> Insurance -> State -> providers, which is how the business actually
// reasons about enrollments: you enroll a practice with a payer in a state, and providers
// sit underneath that. The $1,200 group enrollment fee belongs to the payer+state level,
// so it's surfaced there rather than being attached to whichever provider row happened to
// carry it in ClickUp — that attribution was reading as "we charged this provider $1,200".
router.get("/", (req, res) => {
  const { pcName, state, insurance } = req.query;

  const rows = db.prepare(`
    SELECT t.*, c.name AS client_name
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.source = 'clickup_import'
    ORDER BY c.name, t.payer_name, t.provider_name
  `).all();

  const filtered = rows.filter((t) => {
    const taskStates = JSON.parse(t.assigned_states_json);
    if (pcName && t.client_name !== pcName) return false;
    if (state && !taskStates.includes(state)) return false;
    if (insurance && t.payer_name !== insurance) return false;
    return true;
  });

  const pcs = new Map();
  for (const t of filtered) {
    const amounts = taskAmounts(t);
    const payerName = t.payer_name || "(no payer)";
    const stateName = JSON.parse(t.assigned_states_json)[0] || "(no state)";

    if (!pcs.has(t.client_name)) {
      pcs.set(t.client_name, { clientName: t.client_name, clientId: t.client_id, payers: new Map(), ...emptyTotals() });
    }
    const pc = pcs.get(t.client_name);
    addTotals(pc, amounts);

    if (!pc.payers.has(payerName)) pc.payers.set(payerName, { payerName, states: new Map(), ...emptyTotals() });
    const payer = pc.payers.get(payerName);
    addTotals(payer, amounts);

    if (!payer.states.has(stateName)) {
      payer.states.set(stateName, { state: stateName, providers: [], groupFee: null, ...emptyTotals() });
    }
    const st = payer.states.get(stateName);
    addTotals(st, amounts);

    const entry = {
      id: t.id,
      providerName: t.provider_name,
      status: t.status,
      clickupStatus: t.clickup_status,
      clickupTaskUrl: t.clickup_task_url,
      totalFee: t.total_fee,
      depositDue: t.deposit_due,
      balanceDue: t.balance_due,
      balanceBillable: !!t.balance_billable,
      depositPaymentStatus: t.deposit_payment_status,
      balancePaymentStatus: t.balance_payment_status,
      isDuplicate: t.duplicate_of_task_id != null,
      ...amounts,
    };

    // The one task carrying the group enrollment fee is shown as the payer+state's own
    // line item; everything else lists as a provider.
    const isGroupFee =
      t.total_fee === PAYER_ENROLLMENT_RATE &&
      !st.groupFee &&
      isEntityRow(t.provider_name, t.client_name);
    if (isGroupFee) st.groupFee = entry;
    else st.providers.push(entry);
  }

  // Any payer+state that has a $1,200 charge but no clearly-marked entity row still gets
  // it promoted to the group line, so the fee never reads as an individual's charge.
  for (const pc of pcs.values()) {
    for (const payer of pc.payers.values()) {
      for (const st of payer.states.values()) {
        if (st.groupFee) continue;
        const idx = st.providers.findIndex((p) => p.totalFee === PAYER_ENROLLMENT_RATE);
        if (idx >= 0) st.groupFee = st.providers.splice(idx, 1)[0];
      }
    }
  }

  const clients = [...pcs.values()].map((pc) => ({
    clientId: pc.clientId,
    clientName: pc.clientName,
    paid: pc.paid, owedNow: pc.owedNow, willOwe: pc.willOwe, total: pc.total,
    payers: [...pc.payers.values()].map((p) => ({
      payerName: p.payerName,
      paid: p.paid, owedNow: p.owedNow, willOwe: p.willOwe, total: p.total,
      states: [...p.states.values()].map((s) => ({
        state: s.state,
        paid: s.paid, owedNow: s.owedNow, willOwe: s.willOwe, total: s.total,
        groupFee: s.groupFee,
        providers: s.providers,
      })),
    })),
  }));

  const allImported = db.prepare(`
    SELECT t.payer_name, t.assigned_states_json, c.name AS client_name
    FROM tasks t JOIN clients c ON c.id = t.client_id
    WHERE t.source = 'clickup_import'
  `).all();
  const pcNames = [...new Set(allImported.map((t) => t.client_name))].sort();
  const insurances = [...new Set(allImported.map((t) => t.payer_name).filter(Boolean))].sort();
  const states = [...new Set(allImported.flatMap((t) => JSON.parse(t.assigned_states_json)))].sort();

  const grandTotals = clients.reduce((acc, c) => {
    addTotals(acc, c);
    return acc;
  }, emptyTotals());

  res.json({ clients, filterOptions: { pcNames, states, insurances }, grandTotals });
});

// Monthly growth: total value of enrollments by the month the ClickUp task was actually
// created (not when we imported it), plus a running cumulative total.
router.get("/growth", (req, res) => {
  const rows = db.prepare(`
    SELECT total_fee, clickup_date_created
    FROM tasks
    WHERE source = 'clickup_import' AND clickup_date_created IS NOT NULL
  `).all();

  const byMonth = new Map();
  for (const r of rows) {
    const month = r.clickup_date_created.slice(0, 7);
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
