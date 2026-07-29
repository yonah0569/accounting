const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const projectRoot = path.join(__dirname, "..");
const dbPath = process.env.DB_PATH || "./data/credify_tasks.db";
const resolvedPath = path.resolve(projectRoot, dbPath);
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

const db = new Database(resolvedPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    rate_overrides_json TEXT NOT NULL DEFAULT '{}',
    clickup_custom_field_id TEXT,
    qb_customer_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    services_json TEXT NOT NULL,
    additional_providers INTEGER NOT NULL DEFAULT 0,
    assigned_states_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'Not Started',
    total_fee REAL NOT NULL,
    deposit_due REAL NOT NULL,
    balance_due REAL NOT NULL,
    deposit_payment_status TEXT NOT NULL DEFAULT 'Not Sent',
    balance_payment_status TEXT NOT NULL DEFAULT 'Not Sent',
    clickup_task_id TEXT,
    clickup_task_url TEXT,
    qb_deposit_invoice_id TEXT,
    qb_balance_invoice_id TEXT,
    sync_errors_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Columns added after the initial release — applied idempotently so existing
// databases (with real data already in them) upgrade in place.
const existingColumns = new Set(db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
const migrations = [
  ["source", "TEXT NOT NULL DEFAULT 'manual'"],
  ["provider_name", "TEXT"],
  ["payer_name", "TEXT"],
  ["clickup_status", "TEXT"],
  ["clickup_list_id", "TEXT"],
  ["clickup_list_name", "TEXT"],
  ["balance_billable", "INTEGER NOT NULL DEFAULT 0"],
  ["clickup_date_created", "TEXT"],
  ["duplicate_of_task_id", "INTEGER"],
];
for (const [column, definition] of migrations) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
  }
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_clickup_task_id ON tasks(clickup_task_id) WHERE clickup_task_id IS NOT NULL");

module.exports = db;
