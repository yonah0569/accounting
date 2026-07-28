const express = require("express");
const { syncTask, refreshTaskPaymentStatus, runBatchSync, refreshAllPaymentStatuses, logSyncError } = require("../services/qbSync");
const db = require("../db");

const router = express.Router();

router.post("/tasks/:id/sync", async (req, res) => {
  try {
    const result = await syncTask(req.params.id);
    const row = db.prepare("SELECT sync_errors_json FROM tasks WHERE id = ?").get(req.params.id);
    res.json({ ...result, syncErrors: JSON.parse(row.sync_errors_json) });
  } catch (err) {
    if (err.status !== 404) logSyncError(req.params.id, "quickbooks", err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

router.post("/tasks/:id/refresh-payment-status", async (req, res) => {
  try {
    const result = await refreshTaskPaymentStatus(req.params.id);
    const row = db.prepare("SELECT sync_errors_json FROM tasks WHERE id = ?").get(req.params.id);
    res.json({ ...result, syncErrors: JSON.parse(row.sync_errors_json) });
  } catch (err) {
    if (err.status !== 404 && err.status !== 400) logSyncError(req.params.id, "quickbooks", err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Manual trigger for the same batch job the biweekly scheduler runs.
router.post("/batch-sync", async (req, res) => {
  const result = await runBatchSync();
  res.json(result);
});

// Pulls current payment status for every synced invoice from QuickBooks in bulk and
// marks Paid locally. This is what "check for payments" means — same job the daily
// scheduler runs automatically.
router.post("/refresh-all-payments", async (req, res) => {
  try {
    const result = await refreshAllPaymentStatuses();
    res.json(result);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

module.exports = router;
