const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTask } = require("../src/services/pricing");

test("matches the worked example from the spec: commercial x2 + NPI + 1 extra provider", () => {
  const result = calculateTask({
    services: [
      { type: "commercialEnrollment", payers: 2 },
      { type: "npi" },
    ],
    additionalProviders: 1,
  });

  assert.equal(result.totalFee, 2775);
  assert.equal(result.depositDue, 1387.5);
  assert.equal(result.balanceDue, 1387.5);
});

test("medicaid priced per state", () => {
  const result = calculateTask({ services: [{ type: "medicaid", states: 3 }] });
  assert.equal(result.totalFee, 2925);
});

test("medicare/PECOS priced per state", () => {
  const result = calculateTask({ services: [{ type: "medicarePecos", states: 2 }] });
  assert.equal(result.totalFee, 1550);
});

test("recredentialing priced per payer per provider", () => {
  const result = calculateTask({
    services: [{ type: "recredentialing", payers: 2, providers: 3 }],
  });
  assert.equal(result.totalFee, 1650); // 275 * 2 * 3
});

test("flat-fee services price correctly", () => {
  const result = calculateTask({
    services: [{ type: "caqh" }, { type: "eftEdi" }, { type: "demographicUpdate" }],
  });
  assert.equal(result.totalFee, 250 + 150 + 75);
});

test("license sub-types use distinct rates", () => {
  assert.equal(calculateTask({ services: [{ type: "license", licenseType: "rn" }] }).totalFee, 425);
  assert.equal(calculateTask({ services: [{ type: "license", licenseType: "np" }] }).totalFee, 750);
  assert.equal(calculateTask({ services: [{ type: "license", licenseType: "renewal" }] }).totalFee, 275);
});

test("client rate override replaces the standard rate for that service only", () => {
  const result = calculateTask(
    { services: [{ type: "commercialEnrollment", payers: 1 }, { type: "npi" }] },
    { commercialEnrollment: 1000 }
  );
  assert.equal(result.totalFee, 1100); // 1000 + 100(standard NPI, unaffected)
});

test("deposit + balance always reconcile to total even with odd cents", () => {
  const result = calculateTask({ services: [{ type: "npi" }, { type: "demographicUpdate" }] }); // 175 total
  assert.equal(result.depositDue + result.balanceDue, result.totalFee);
});
