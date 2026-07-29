const tokenStore = require("./quickbooksTokens");

const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

class QuickBooksError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "QuickBooksError";
    this.status = status;
    this.body = body;
  }
}

function apiBase() {
  return process.env.QUICKBOOKS_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

function basicAuthHeader() {
  const creds = `${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}

function getAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.QUICKBOOKS_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: process.env.QUICKBOOKS_REDIRECT_URI,
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.QUICKBOOKS_REDIRECT_URI,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new QuickBooksError(data.error_description || "Token exchange failed", res.status, data);
  return data;
}

async function refreshTokens(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new QuickBooksError(data.error_description || "Token refresh failed", res.status, data);
  return data;
}

// Revokes the connection on Intuit's side — used by the app's Disconnect flow.
async function revokeTokens(token) {
  const res = await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ token }),
  });
  if (!res.ok && res.status !== 200) {
    const data = await res.json().catch(() => ({}));
    throw new QuickBooksError(data.error_description || "Token revoke failed", res.status, data);
  }
}

// Returns a valid access token + realmId, refreshing if the current one is expired or about to be.
async function getValidTokens() {
  const tokens = tokenStore.load();
  if (!tokens) {
    const err = new QuickBooksError("QuickBooks is not connected yet — complete the OAuth flow first.", 401);
    throw err;
  }
  if (Date.now() < tokens.expiresAt - 60_000) return tokens;

  const refreshed = await refreshTokens(tokens.refreshToken);
  const updated = {
    ...tokens,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };
  tokenStore.save(updated);
  return updated;
}

async function qboRequest(pathSegment, { method = "GET", body, retry = 0, authRetried = false } = {}) {
  const tokens = await getValidTokens();
  const res = await fetch(`${apiBase()}/v3/company/${tokens.realmId}${pathSegment}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429 && retry < 6) {
    await new Promise((r) => setTimeout(r, Math.min(30000, 1500 * 2 ** retry)));
    return qboRequest(pathSegment, { method, body, retry: retry + 1, authRetried });
  }

  // A 401 despite our proactive refresh means the token was invalidated some other way
  // (revoked, clock skew) — force one refresh and retry once before giving up.
  if (res.status === 401 && !authRetried) {
    const tid = res.headers.get("intuit_tid");
    console.error(`[quickbooks] 401 on ${pathSegment}, forcing token refresh and retrying once${tid ? ` (intuit_tid=${tid})` : ""}`);
    const current = tokenStore.load();
    if (current) {
      const refreshed = await refreshTokens(current.refreshToken);
      tokenStore.save({
        ...current,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || current.refreshToken,
        expiresAt: Date.now() + refreshed.expires_in * 1000,
      });
      return qboRequest(pathSegment, { method, body, retry, authRetried: true });
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.Fault?.Error?.[0]?.Message || `QuickBooks API error (${res.status})`;
    throw new QuickBooksError(message, res.status, { ...data, intuit_tid: res.headers.get("intuit_tid") });
  }
  return data;
}

// QuickBooks reserves ":" as the parent:child name separator — a literal colon in a
// DisplayName causes "Invalid String" errors, so it's replaced before ever touching QBO.
function sanitizeName(name) {
  return name.replace(/:/g, " -").replace(/\s+/g, " ").trim();
}

async function findCustomerByName(name) {
  const escaped = sanitizeName(name).replace(/'/g, "\\'");
  const data = await qboRequest(`/query?query=${encodeURIComponent(`select * from Customer where DisplayName = '${escaped}'`)}`);
  return data.QueryResponse?.Customer?.[0] || null;
}

async function createCustomer(name) {
  const data = await qboRequest("/customer", { method: "POST", body: { DisplayName: sanitizeName(name) } });
  return data.Customer;
}

// Concurrent syncs can race to create the same new customer; QBO rejects the loser with
// "Duplicate Name Exists Error" — that's not a real failure, just re-fetch the winner's record.
async function findOrCreateCustomer(name) {
  const existing = await findCustomerByName(name);
  if (existing) return existing;
  try {
    return await createCustomer(name);
  } catch (err) {
    if (err.message.includes("Duplicate Name Exists")) {
      const nowExists = await findCustomerByName(name);
      if (nowExists) return nowExists;
    }
    throw err;
  }
}

async function findServiceItem(name) {
  const escaped = name.replace(/'/g, "\\'");
  const existing = await qboRequest(`/query?query=${encodeURIComponent(`select * from Item where Name = '${escaped}'`)}`);
  return existing.QueryResponse?.Item?.[0] || null;
}

async function ensureServiceItem(name, unitPrice) {
  const existing = await findServiceItem(name);
  if (existing) return existing;

  const incomeAccounts = await qboRequest(
    `/query?query=${encodeURIComponent("select * from Account where AccountType = 'Income'")}`
  );
  const incomeAccount = incomeAccounts.QueryResponse?.Account?.[0];
  if (!incomeAccount) throw new QuickBooksError("No Income account found in QuickBooks to attach the service item to", 500);

  try {
    const created = await qboRequest("/item", {
      method: "POST",
      body: {
        Name: name,
        Type: "Service",
        UnitPrice: unitPrice,
        IncomeAccountRef: { value: incomeAccount.Id },
      },
    });
    return created.Item;
  } catch (err) {
    if (err.message.includes("Duplicate Name Exists")) {
      const nowExists = await findServiceItem(name);
      if (nowExists) return nowExists;
    }
    throw err;
  }
}

async function createInvoice({ customerId, itemName, amount, memo, docNumber }) {
  const item = await ensureServiceItem(itemName, amount);
  const data = await qboRequest("/invoice", {
    method: "POST",
    body: {
      CustomerRef: { value: customerId },
      PrivateNote: memo,
      Line: [
        {
          Amount: amount,
          DetailType: "SalesItemLineDetail",
          Description: memo,
          SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: amount },
        },
      ],
    },
  });
  return data.Invoice;
}

async function getInvoice(invoiceId) {
  const data = await qboRequest(`/invoice/${invoiceId}`);
  return data.Invoice;
}

// Corrects an existing invoice's amount in place (sparse update) rather than
// deleting and recreating it — used when ClickUp's real tracked amount differs
// from what was originally billed.
async function updateInvoiceAmount(invoiceId, newAmount) {
  const current = await getInvoice(invoiceId);
  const lines = current.Line.map((line) =>
    line.DetailType === "SalesItemLineDetail"
      ? { ...line, Amount: newAmount, SalesItemLineDetail: { ...line.SalesItemLineDetail, UnitPrice: newAmount } }
      : line
  );
  const data = await qboRequest("/invoice", {
    method: "POST",
    body: { Id: current.Id, SyncToken: current.SyncToken, sparse: true, Line: lines },
  });
  return data.Invoice;
}

const query = (sql) => qboRequest(`/query?query=${encodeURIComponent(sql)}`);

// Voids/deletes an invoice — used when a task's charge is removed entirely (e.g. a
// duplicate group enrollment that shouldn't have been billed).
async function deleteInvoice(invoiceId, syncToken) {
  return qboRequest("/invoice?operation=delete", {
    method: "POST",
    body: { Id: invoiceId, SyncToken: syncToken },
  });
}

module.exports = {
  QuickBooksError,
  getAuthorizeUrl,
  exchangeCodeForTokens,
  getValidTokens,
  revokeTokens,
  findOrCreateCustomer,
  createInvoice,
  getInvoice,
  updateInvoiceAmount,
  deleteInvoice,
  query,
};
