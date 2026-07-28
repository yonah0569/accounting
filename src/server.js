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
