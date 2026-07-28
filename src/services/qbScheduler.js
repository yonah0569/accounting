const fs = require("node:fs");
const path = require("node:path");
const { runBatchSync, refreshAllPaymentStatuses } = require("./qbSync");

// A recurring job: runs immediately on startup if overdue (or never run), then every
// `intervalMs` after that. State (last run time/result) persists across restarts.
function createScheduler({ name, stateFileName, intervalMs, run }) {
  const stateFile = path.join(__dirname, "..", "..", "data", stateFileName);

  function loadState() {
    if (!fs.existsSync(stateFile)) return { lastRunAt: null };
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  }
  function saveState(state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  async function runAndRecord() {
    console.log(`[${name}] running...`);
    const result = await run();
    saveState({ lastRunAt: new Date().toISOString(), lastResult: result });
    console.log(`[${name}] done:`, JSON.stringify(result));
    return result;
  }

  function start() {
    const state = loadState();
    const dueAt = state.lastRunAt ? new Date(state.lastRunAt).getTime() + intervalMs : 0;
    const msUntilDue = Math.max(0, dueAt - Date.now());

    setTimeout(function scheduleNext() {
      runAndRecord()
        .catch((err) => console.error(`[${name}] failed:`, err.message))
        .finally(() => setInterval(() => runAndRecord().catch((err) => console.error(`[${name}] failed:`, err.message)), intervalMs));
    }, msUntilDue);

    console.log(`[${name}] next run in ${Math.round(msUntilDue / 1000 / 60)} minutes`);
  }

  function getStatus() {
    const state = loadState();
    const nextRunAt = state.lastRunAt ? new Date(new Date(state.lastRunAt).getTime() + intervalMs).toISOString() : null;
    return { ...state, nextRunAt, intervalMs };
  }

  return { start, runAndRecord, getStatus };
}

// Creates new invoices for tasks that need them — every 14 days, per the confirmed
// billing cadence (deposit at start, balance once approved/active).
const invoiceScheduler = createScheduler({
  name: "qb-invoice-scheduler",
  stateFileName: "qb-sync-schedule.json",
  intervalMs: 14 * 24 * 60 * 60 * 1000,
  run: runBatchSync,
});

// Checks QuickBooks for incoming payments — daily, so a payment that comes in gets
// reflected in the dashboard within a day rather than waiting for the biweekly cycle.
const paymentScheduler = createScheduler({
  name: "qb-payment-scheduler",
  stateFileName: "qb-payment-schedule.json",
  intervalMs: 24 * 60 * 60 * 1000,
  run: refreshAllPaymentStatuses,
});

function start() {
  invoiceScheduler.start();
  paymentScheduler.start();
}

function getStatus() {
  return {
    invoiceSync: invoiceScheduler.getStatus(),
    paymentCheck: paymentScheduler.getStatus(),
  };
}

module.exports = { start, getStatus, invoiceScheduler, paymentScheduler };
