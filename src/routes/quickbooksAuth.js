const express = require("express");
const crypto = require("node:crypto");
const quickbooks = require("../services/quickbooks");
const tokenStore = require("../services/quickbooksTokens");

const router = express.Router();
let pendingState = null;

router.get("/quickbooks", (req, res) => {
  pendingState = crypto.randomBytes(16).toString("hex");
  res.redirect(quickbooks.getAuthorizeUrl(pendingState));
});

router.get("/quickbooks/callback", async (req, res) => {
  const { code, state, realmId, error } = req.query;

  if (error) {
    return res.status(400).send(`<h1>QuickBooks connection failed</h1><p>${error}</p>`);
  }
  if (!state || state !== pendingState) {
    return res.status(400).send("<h1>QuickBooks connection failed</h1><p>Invalid or expired state parameter.</p>");
  }
  pendingState = null;

  try {
    const tokens = await quickbooks.exchangeCodeForTokens(code);
    tokenStore.save({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      realmId,
    });
    res.send(`
      <h1>QuickBooks connected</h1>
      <p>Realm ID: ${realmId}</p>
      <p>You can close this tab and go back to the Credify tracker.</p>
      <a href="/">Return to app</a>
    `);
  } catch (err) {
    res.status(502).send(`<h1>QuickBooks connection failed</h1><pre>${err.message}</pre>`);
  }
});

router.get("/quickbooks/status", (req, res) => {
  const tokens = tokenStore.load();
  res.json({ connected: !!tokens, realmId: tokens?.realmId || null });
});

// Intuit's required Disconnect URL — revokes the connection and clears local tokens.
router.get("/quickbooks/disconnect", async (req, res) => {
  const tokens = tokenStore.load();
  if (tokens) {
    try {
      await quickbooks.revokeTokens(tokens.refreshToken);
    } catch (err) {
      // best-effort — clear locally regardless so the app reflects "disconnected"
    }
    tokenStore.clear();
  }
  res.send(`
    <h1>QuickBooks disconnected</h1>
    <p>This app no longer has access to your QuickBooks company.</p>
    <a href="/">Return to app</a>
  `);
});

module.exports = router;
