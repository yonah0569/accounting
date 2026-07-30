const fs = require("node:fs");
const path = require("node:path");
const { runBatchSync, refreshAllPaymentStatuses } = require("./qbSync");
const { importAllCommercial } = require("./clickupImport");
const { repriceDuplicateGroupFees, repriceDuplicateProviders } = require("./reprice");

// A recurring job that runs every `intervalMs`, with its last-run time persisted so the
// schedule survives restarts.
//
// `startupGraceMs` is deliberately never zero: a job that fires during boot will run on
// every restart, and for the heavy billing cycle that meant import-everything-then-crash
// on a small instance, which restarts, which imports again — a crash loop that takes the
// whole service down. Holding off until after the app is serving keeps a restart cheap.
function createScheduler({ name, stateFileName, intervalMs, run, startupGraceMs = 5 * 60 * 1000 }) {
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
    const msUntilDue = Math.max(startupGraceMs, dueAt - Date.now());

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

// The full billing cycle, every 3 weeks: pull the latest enrollments and prices from
// ClickUp, collapse any duplicate group fees across the whole dataset, then push the
// resulting invoices to QuickBooks. This is the ClickUp -> QuickBooks pipeline; the app
// is the mediator between them.
async function runBillingCycle() {
  const imported = await importAllCommercial();
  const dupeFees = repriceDuplicateGroupFees();
  const dupeProviders = repriceDuplicateProviders();
  const invoiced = await runBatchSync({ concurrency: 4 });
  return {
    importedTasks: imported.imported,
    importFailures: imported.failures.length,
    duplicatesRemoved: dupeFees.tasksZeroed + dupeProviders.tasksZeroed,
    succeeded: invoiced.succeeded,
    failed: invoiced.failed,
  };
}

const invoiceScheduler = createScheduler({
  name: "billing-cycle",
  stateFileName: "qb-sync-schedule.json",
  intervalMs: 21 * 24 * 60 * 60 * 1000,
  run: runBillingCycle,
  // The heaviest job in the app — keep it well clear of boot so restarts stay cheap.
  startupGraceMs: 20 * 60 * 1000,
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

module.exports = { start, getStatus, invoiceScheduler, paymentScheduler, runBillingCycle };
