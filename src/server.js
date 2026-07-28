const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");

const clientsRouter = require("./routes/clients");
const tasksRouter = require("./routes/tasks");
const clickupRouter = require("./routes/clickup");
const quickbooksRouter = require("./routes/quickbooks");
const quickbooksAuthRouter = require("./routes/quickbooksAuth");
const dashboardRouter = require("./routes/dashboard");
const { STANDARD_RATES } = require("./services/pricing");
const qbScheduler = require("./services/qbScheduler");

const app = express();
app.use(express.json());

// Simple password gate for the deployed app — this handles real financial/health
// credentialing data with no other login system, so it must not be publicly reachable
// without a password. No-op locally unless APP_PASSWORD is set, so local dev is unaffected.
function requireAuth(req, res, next) {
  if (!process.env.APP_PASSWORD) return next();
  const expected = `Basic ${Buffer.from(`${process.env.APP_USERNAME || "credify"}:${process.env.APP_PASSWORD}`).toString("base64")}`;
  if (req.headers.authorization === expected) return next();
  res.set("WWW-Authenticate", 'Basic realm="Credify Tracker"');
  res.status(401).send("Authentication required");
}
app.use(requireAuth);

app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/clients", clientsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/clickup", clickupRouter);
app.use("/api/quickbooks", quickbooksRouter);
app.use("/auth", quickbooksAuthRouter);
app.use("/api/dashboard", dashboardRouter);

app.get("/api/quickbooks/schedule-status", (req, res) => {
  res.json(qbScheduler.getStatus());
});

app.get("/api/rates", (req, res) => {
  res.json(STANDARD_RATES);
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Credify tracker listening on http://localhost:${port}`);
  qbScheduler.start();
});
