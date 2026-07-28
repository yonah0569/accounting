const express = require("express");
const clickup = require("../services/clickup");
const clickupConfig = require("../services/clickupConfig");
const { importCommercialList } = require("../services/clickupImport");

const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, body: err.body });
    }
  };
}

const FIELD_DEFS = [
  { key: "client", name: "Client", type: "text" },
  { key: "clientId", name: "Client ID", type: "number" },
  { key: "serviceType", name: "Service Type", type: "text" },
  { key: "totalFee", name: "Total Fee", type: "currency" },
  { key: "depositDue", name: "Deposit Due", type: "currency" },
  { key: "balanceDue", name: "Balance Due", type: "currency" },
  {
    key: "depositPaymentStatus",
    name: "Deposit Payment Status",
    type: "drop_down",
    options: ["Not Sent", "Sent", "Paid"],
  },
  {
    key: "balancePaymentStatus",
    name: "Balance Payment Status",
    type: "drop_down",
    options: ["Not Sent", "Sent", "Paid"],
  },
  {
    key: "credentialingStatus",
    name: "Credentialing Status",
    type: "drop_down",
    options: ["Not Started", "In Progress", "Submitted", "Approved", "Active", "Paid"],
  },
  { key: "assignedStates", name: "Assigned States", type: "text" },
  { key: "qbDepositInvoiceId", name: "QB Deposit Invoice #", type: "text" },
  { key: "qbBalanceInvoiceId", name: "QB Balance Invoice #", type: "text" },
];

function fieldPayload(def) {
  if (def.type === "currency") {
    return { name: def.name, type: "currency", type_config: { default: 0, precision: 2, currency_type: "USD" } };
  }
  if (def.type === "drop_down") {
    return {
      name: def.name,
      type: "drop_down",
      type_config: { options: def.options.map((name) => ({ name })) },
    };
  }
  return { name: def.name, type: def.type, type_config: {} };
}

// One-time setup: creates the "Credentialing Tasks" list in the given folder with
// all custom fields the app needs, and persists the resulting IDs to data/clickup-config.json.
router.post("/setup", handle(async (req) => {
  const { folderId, listName } = req.body;
  if (!folderId) {
    const err = new Error("folderId is required");
    err.status = 400;
    throw err;
  }

  const list = await clickup.createList(folderId, listName || "Credentialing Tasks");

  for (const def of FIELD_DEFS) {
    await clickup.createCustomField(list.id, fieldPayload(def));
  }

  // ClickUp's create-field endpoint returns an empty body on success, so read the
  // authoritative field list back afterward to capture IDs (including drop_down option IDs).
  const { fields: createdFields } = await clickup.getCustomFields(list.id);
  const fields = {};
  for (const def of FIELD_DEFS) {
    const match = createdFields.find((f) => f.name === def.name);
    if (!match) continue;
    if (def.type === "drop_down") {
      const options = {};
      for (const opt of match.type_config.options) options[opt.name] = opt.id;
      fields[def.key] = { id: match.id, options };
    } else {
      fields[def.key] = match.id;
    }
  }

  const config = { teamId: process.env.CLICKUP_TEAM_ID, folderId, listId: list.id, listName: list.name, fields };
  clickupConfig.save(config);
  return config;
}));

router.get("/config", handle(() => clickupConfig.load() || {}));

// Imports a Commercial Enrollment list from the real Enrollments workspace into the
// local task table. dryRun=true previews without writing to the database.
router.post("/import-commercial", handle(async (req) => {
  const { listId, clientName, dryRun } = req.body;
  if (!listId || !clientName) {
    const err = new Error("listId and clientName are required");
    err.status = 400;
    throw err;
  }
  return importCommercialList(listId, clientName, { dryRun: !!dryRun });
}));

router.get("/teams", handle(() => clickup.getTeams()));
router.get("/teams/:teamId/spaces", handle((req) => clickup.getSpaces(req.params.teamId)));
router.get("/spaces/:spaceId/folders", handle((req) => clickup.getFolders(req.params.spaceId)));
router.get("/spaces/:spaceId/lists", handle((req) => clickup.getFolderlessLists(req.params.spaceId)));
router.get("/folders/:folderId/lists", handle((req) => clickup.getListsInFolder(req.params.folderId)));
router.get("/lists/:listId/fields", handle((req) => clickup.getCustomFields(req.params.listId)));

module.exports = router;
