// Hardcoded standard rates per the Credify pricing sheet. Do not change without sign-off.
const STANDARD_RATES = Object.freeze({
  commercialEnrollment: 1200, // per payer
  medicaid: 975, // per state
  medicarePecos: 775, // per state
  recredentialing: 275, // per payer per provider
  caqh: 250, // flat
  eftEdi: 150, // flat
  npi: 100, // flat
  rnLicense: 425, // flat
  npLicense: 750, // flat
  licenseRenewal: 275, // flat
  demographicUpdate: 75, // flat
  additionalProvider: 275, // each beyond the 3 included
});

const SERVICE_LABELS = Object.freeze({
  commercialEnrollment: "Commercial Payer Enrollment",
  medicaid: "Medicaid",
  medicarePecos: "Medicare/PECOS",
  recredentialing: "Recredentialing",
  caqh: "CAQH",
  eftEdi: "EFT/EDI",
  npi: "NPI",
  license: "License",
  demographicUpdate: "Demographic Update",
});

const LICENSE_RATE_KEYS = Object.freeze({
  rn: "rnLicense",
  np: "npLicense",
  renewal: "licenseRenewal",
});

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function resolveRates(overrides) {
  if (!overrides) return STANDARD_RATES;
  const merged = { ...STANDARD_RATES };
  for (const key of Object.keys(overrides)) {
    if (key in STANDARD_RATES && typeof overrides[key] === "number" && overrides[key] >= 0) {
      merged[key] = overrides[key];
    }
  }
  return merged;
}

// Computes one line item's subtotal + a human label. Throws on malformed input
// so the caller can surface a validation error rather than silently mispricing.
function priceService(service, rates) {
  const { type } = service;

  switch (type) {
    case "commercialEnrollment": {
      const payers = Number(service.payers) || 0;
      return {
        type,
        label: SERVICE_LABELS[type],
        detail: `${payers} payer${payers === 1 ? "" : "s"} x $${rates.commercialEnrollment}`,
        qty: payers,
        rate: rates.commercialEnrollment,
        subtotal: round2(payers * rates.commercialEnrollment),
      };
    }
    case "medicaid": {
      const states = Number(service.states) || 0;
      return {
        type,
        label: SERVICE_LABELS[type],
        detail: `${states} state${states === 1 ? "" : "s"} x $${rates.medicaid}`,
        qty: states,
        rate: rates.medicaid,
        subtotal: round2(states * rates.medicaid),
      };
    }
    case "medicarePecos": {
      const states = Number(service.states) || 0;
      return {
        type,
        label: SERVICE_LABELS[type],
        detail: `${states} state${states === 1 ? "" : "s"} x $${rates.medicarePecos}`,
        qty: states,
        rate: rates.medicarePecos,
        subtotal: round2(states * rates.medicarePecos),
      };
    }
    case "recredentialing": {
      const payers = Number(service.payers) || 0;
      const providers = Number(service.providers) || 0;
      return {
        type,
        label: SERVICE_LABELS[type],
        detail: `${payers} payer${payers === 1 ? "" : "s"} x ${providers} provider${providers === 1 ? "" : "s"} x $${rates.recredentialing}`,
        qty: payers * providers,
        rate: rates.recredentialing,
        subtotal: round2(payers * providers * rates.recredentialing),
      };
    }
    case "caqh":
    case "eftEdi":
    case "npi":
    case "demographicUpdate": {
      const rateKey = type;
      return {
        type,
        label: SERVICE_LABELS[type],
        detail: `flat x $${rates[rateKey]}`,
        qty: 1,
        rate: rates[rateKey],
        subtotal: round2(rates[rateKey]),
      };
    }
    case "license": {
      const licenseType = service.licenseType;
      const rateKey = LICENSE_RATE_KEYS[licenseType];
      if (!rateKey) {
        throw new Error(`Unknown licenseType "${licenseType}" for service "license"`);
      }
      const licenseLabels = { rn: "RN License", np: "NP/New Professional License", renewal: "License Renewal" };
      return {
        type,
        label: licenseLabels[licenseType],
        detail: `flat x $${rates[rateKey]}`,
        qty: 1,
        rate: rates[rateKey],
        subtotal: round2(rates[rateKey]),
      };
    }
    default:
      throw new Error(`Unknown service type "${type}"`);
  }
}

// input = { services: [{type, ...qty fields}], additionalProviders }
// clientRateOverrides = optional partial map of rate overrides for a negotiated client rate
function calculateTask(input, clientRateOverrides) {
  const rates = resolveRates(clientRateOverrides);
  const services = Array.isArray(input.services) ? input.services : [];
  const additionalProviders = Math.max(0, Number(input.additionalProviders) || 0);

  const lineItems = services.map((service) => priceService(service, rates));

  if (additionalProviders > 0) {
    lineItems.push({
      type: "additionalProvider",
      label: "Additional Providers (beyond 3 included)",
      detail: `${additionalProviders} x $${rates.additionalProvider}`,
      qty: additionalProviders,
      rate: rates.additionalProvider,
      subtotal: round2(additionalProviders * rates.additionalProvider),
    });
  }

  const totalFee = round2(lineItems.reduce((sum, item) => sum + item.subtotal, 0));
  const depositDue = round2(totalFee * 0.5);
  const balanceDue = round2(totalFee - depositDue);

  return { lineItems, totalFee, depositDue, balanceDue, ratesUsed: rates };
}

module.exports = { calculateTask, STANDARD_RATES, SERVICE_LABELS, round2 };
