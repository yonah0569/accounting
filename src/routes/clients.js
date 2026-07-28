const express = require("express");
const db = require("../db");

const router = express.Router();

function serializeClient(row) {
  return {
    id: row.id,
    name: row.name,
    rateOverrides: JSON.parse(row.rate_overrides_json),
    clickupCustomFieldId: row.clickup_custom_field_id,
    qbCustomerId: row.qb_customer_id,
    createdAt: row.created_at,
  };
}

router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM clients ORDER BY name").all();
  res.json(rows.map(serializeClient));
});

router.post("/", (req, res) => {
  const { name, rateOverrides } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    const stmt = db.prepare(
      "INSERT INTO clients (name, rate_overrides_json) VALUES (?, ?)"
    );
    const info = stmt.run(name.trim(), JSON.stringify(rateOverrides || {}));
    const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json(serializeClient(row));
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "A client with that name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", (req, res) => {
  const { rateOverrides } = req.body;
  const existing = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Client not found" });

  db.prepare("UPDATE clients SET rate_overrides_json = ? WHERE id = ?").run(
    JSON.stringify(rateOverrides || {}),
    req.params.id
  );
  const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
  res.json(serializeClient(row));
});

module.exports = router;
