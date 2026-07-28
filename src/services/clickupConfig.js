const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(__dirname, "..", "..", "data", "clickup-config.json");

function load() {
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function save(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

module.exports = { load, save };
