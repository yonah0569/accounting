const clickup = require("./clickup");
const clickupConfig = require("./clickupConfig");
const { SERVICE_LABELS } = require("./pricing");

function serviceSummary(services) {
  return services
    .map((s) => (s.type === "license" ? "License" : SERVICE_LABELS[s.type] || s.type))
    .join(", ");
}

function buildDescription(task, client, lineItems) {
  const lines = lineItems.map((li) => `- ${li.label}: ${li.detail} = $${li.subtotal.toFixed(2)}`);
  return [
    `Client: ${client.name}`,
    `Total Fee: $${task.totalFee.toFixed(2)}`,
    `Deposit Due: $${task.depositDue.toFixed(2)} (50%, non-refundable)`,
    `Balance Due: $${task.balanceDue.toFixed(2)} (50%)`,
    "",
    "Line items:",
    ...lines,
    "",
    task.notes ? `Notes: ${task.notes}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

async function syncTaskToClickUp(task, client, lineItems) {
  const config = clickupConfig.load();
  if (!config || !config.listId) {
    const err = new Error("ClickUp is not configured yet — run the list/field setup first.");
    err.status = 400;
    throw err;
  }

  const created = await clickup.createTask(config.listId, {
    name: `${client.name} — ${serviceSummary(task.services)}`,
    description: buildDescription(task, client, lineItems),
  });

  const f = config.fields;
  const setField = (fieldId, value) => clickup.setCustomFieldValue(created.id, fieldId, value);

  await Promise.all([
    setField(f.client, client.name),
    setField(f.clientId, client.id),
    setField(f.serviceType, serviceSummary(task.services)),
    setField(f.totalFee, task.totalFee),
    setField(f.depositDue, task.depositDue),
    setField(f.balanceDue, task.balanceDue),
    setField(f.depositPaymentStatus.id, f.depositPaymentStatus.options[task.depositPaymentStatus]),
    setField(f.balancePaymentStatus.id, f.balancePaymentStatus.options[task.balancePaymentStatus]),
    setField(f.credentialingStatus.id, f.credentialingStatus.options[task.status]),
    task.assignedStates.length ? setField(f.assignedStates, task.assignedStates.join(", ")) : null,
  ]);

  return { taskId: created.id, url: created.url };
}

async function updateClickUpStatusFields(clickupTaskId, { status, depositPaymentStatus, balancePaymentStatus, qbDepositInvoiceId, qbBalanceInvoiceId }) {
  const config = clickupConfig.load();
  if (!config || !config.listId) return;
  const f = config.fields;
  const setField = (fieldId, value) => clickup.setCustomFieldValue(clickupTaskId, fieldId, value);

  const updates = [];
  if (status) updates.push(setField(f.credentialingStatus.id, f.credentialingStatus.options[status]));
  if (depositPaymentStatus) updates.push(setField(f.depositPaymentStatus.id, f.depositPaymentStatus.options[depositPaymentStatus]));
  if (balancePaymentStatus) updates.push(setField(f.balancePaymentStatus.id, f.balancePaymentStatus.options[balancePaymentStatus]));
  if (qbDepositInvoiceId) updates.push(setField(f.qbDepositInvoiceId, qbDepositInvoiceId));
  if (qbBalanceInvoiceId) updates.push(setField(f.qbBalanceInvoiceId, qbBalanceInvoiceId));
  await Promise.all(updates);
}

module.exports = { syncTaskToClickUp, updateClickUpStatusFields };
