const fs = require("node:fs");
const path = require("node:path");

const tokensPath = path.join(__dirname, "..", "..", "data", "quickbooks-tokens.json");

function load() {
  if (!fs.existsSync(tokensPath)) return null;
  return JSON.parse(fs.readFileSync(tokensPath, "utf8"));
}

function save(tokens) {
  fs.mkdirSync(path.dirname(tokensPath), { recursive: true });
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
}

function clear() {
  if (fs.existsSync(tokensPath)) fs.unlinkSync(tokensPath);
}

module.exports = { load, save, clear };
