const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const http = require("http");
const { spawn } = require("child_process");

const baseEnv = { ...process.env };
if (!(baseEnv.SUPABASE_URL || baseEnv.NEXT_PUBLIC_SUPABASE_URL) || !baseEnv.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase env vars; provider smoke tests need seeded Supabase login.");
  process.exit(1);
}

const originalGemini = baseEnv.GEMINI_API_KEY || "";
const originalOpenRouter = baseEnv.OPENROUTER_API_KEY || "";
const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-chat-v3.1";
const runRealProviders = baseEnv.SMOKE_REAL_AI === "1";
let nextPort = Number(baseEnv.SMOKE_AI_PORT || 3497);

function openRouterModel(overrides = {}) {
  return overrides.OPENROUTER_MODEL || baseEnv.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
}

function warnProblematicOpenRouterModel(model = "") {
  if (/gpt-oss|openrouter\/free/i.test(model)) {
    console.warn(`${model}: warning - this OpenRouter model/router can return reasoning-only output. Use a content-returning model such as ${DEFAULT_OPENROUTER_MODEL}.`);
  }
}

function waitForServer(baseUrl) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(`${baseUrl}/health`, (res) => {
        res.resume();
        resolve();
      }).on("error", () => {
        if (Date.now() - started > 10000) reject(new Error("server did not start"));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function request(baseUrl, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} ${res.status}: ${data.error || text || "request failed"}`);
  return data;
}

async function login(baseUrl) {
  const data = await request(baseUrl, "/api/login", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  return { Authorization: `Bearer ${data.token}` };
}

function expectField(name, actual, expected) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}

async function runTakealotExtractionCase(baseUrl, auth) {
  const text = [
    "TAX INVOICE",
    "Supplier Address",
    "BUSINESS NAME SmudgeXpressions",
    "Merchant VAT number -",
    "Customer Information",
    "BUSINESS NAME -",
    "Invoice Number 232861529",
    "Invoice Date 2025/11/26",
    "SUB-TOTAL VAT TOTAL",
    "R 233.00 R 0.00 R 233.00",
    "TOTAL R 233.00",
  ].join(" ");
  const extract = await request(baseUrl, "/api/extract", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      fileName: "Invoice_232861529.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from(text).toString("base64"),
      documentType: "invoice",
    }),
  });

  expectField("takealot vendor", extract.extracted?.vendor_name, "SmudgeXpressions");
  expectField("takealot invoiceNumber", extract.extracted?.invoice_number, "232861529");
  expectField("takealot date", extract.extracted?.invoice_date, "2025-11-26");
  expectField("takealot amount", Number(extract.extracted?.total_amount), 233);
  expectField("takealot vat", Number(extract.extracted?.vat_amount), 0);

  const behalfText = [
    "TAX INVOICE",
    "Invoice is issued on behalf of SmudgeXpressions",
    "Customer Information",
    "BUSINESS NAME -",
    "Invoice Number 232861529",
    "Invoice Date 2025/11/26",
    "VAT R 0.00",
    "TOTAL R 233.00",
  ].join(" ");
  const behalfExtract = await request(baseUrl, "/api/extract", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      fileName: "Invoice_232861529-behalf.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from(behalfText).toString("base64"),
      documentType: "invoice",
    }),
  });

  expectField("takealot behalf vendor", behalfExtract.extracted?.vendor_name, "SmudgeXpressions");
  expectField("takealot behalf vat", Number(behalfExtract.extracted?.vat_amount), 0);
}

async function runScenario(name, overrides, expectations) {
  const port = nextPort++;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...baseEnv,
      PORT: String(port),
      AI_PROVIDER_TIMEOUT_MS: overrides.AI_PROVIDER_TIMEOUT_MS || "5000",
      GEMINI_API_KEY: overrides.GEMINI_API_KEY ?? "",
      OPENROUTER_API_KEY: overrides.OPENROUTER_API_KEY ?? "",
      OPENROUTER_MODEL: openRouterModel(overrides),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childLogs = [];
  const collectLog = (chunk) => {
    childLogs.push(String(chunk));
    if (childLogs.length > 30) childLogs.shift();
  };
  child.stdout.on("data", collectLog);
  child.stderr.on("data", collectLog);

  try {
    await waitForServer(baseUrl);
    const auth = await login(baseUrl);
    const text = [
      `Supplier: ${name} Vendor Pty Ltd`,
      `Invoice Number: ${name.toUpperCase().replace(/[^A-Z0-9]/g, "-")}-001`,
      "Invoice Date: 2026-06-23",
      "VAT: R12.00",
      "Total: R112.00",
    ].join("\n");
    const extract = await request(baseUrl, "/api/extract", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        fileName: `${name}.pdf`,
        mimeType: "application/pdf",
        dataBase64: Buffer.from(text).toString("base64"),
        documentType: "invoice",
      }),
    });
    if (expectations.extractUsed !== undefined && extract.ai_provider_used !== expectations.extractUsed) {
      throw new Error(`${name}: expected extraction provider ${expectations.extractUsed}, got ${extract.ai_provider_used}`);
    }
    if (expectations.extractMethod && extract.extraction_method !== expectations.extractMethod) {
      throw new Error(`${name}: expected extraction method ${expectations.extractMethod}, got ${extract.extraction_method}`);
    }
    if (expectations.takealotCase) {
      await runTakealotExtractionCase(baseUrl, auth);
    }

    const insights = await request(baseUrl, "/api/insights", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ filters: {} }),
    });
    if (!Array.isArray(insights.insights) || !insights.insights.length) {
      throw new Error(`${name}: insights returned no data`);
    }
    if (expectations.insightsMethod && insights.method !== expectations.insightsMethod) {
      throw new Error(`${name}: expected insights method ${expectations.insightsMethod}, got ${insights.method}`);
    }
    console.log(`${name}: passed`);
  } catch (err) {
    if (expectations.realProvider) {
      console.error(`${name}: real provider smoke failed: ${err.message}`);
      const logs = childLogs.join("").trim();
      if (logs) console.error(logs);
    }
    throw err;
  } finally {
    child.kill();
  }
}

(async () => {
  await runScenario("no-keys", {}, {
    extractUsed: null,
    extractMethod: "ocr_rules_fallback",
    insightsMethod: "rule_based",
    takealotCase: true,
  });

  await runScenario("fake-gemini-no-openrouter", { GEMINI_API_KEY: "fake-gemini-key" }, {
    extractUsed: null,
    extractMethod: "ocr_rules_fallback",
    insightsMethod: "rule_based",
  });

  await runScenario("fake-gemini-fake-openrouter", {
    GEMINI_API_KEY: "fake-gemini-key",
    OPENROUTER_API_KEY: "fake-openrouter-key",
  }, {
    extractUsed: null,
    extractMethod: "ocr_rules_fallback",
    insightsMethod: "rule_based",
  });

  if (runRealProviders && originalGemini) {
    await runScenario("valid-gemini", { GEMINI_API_KEY: originalGemini }, {
      extractUsed: "gemini",
      extractMethod: "ocr_rules_gemini",
      insightsMethod: "gemini",
      realProvider: true,
    });
  } else {
    console.log("valid-gemini: skipped (set SMOKE_REAL_AI=1 with GEMINI_API_KEY to run)");
  }

  if (runRealProviders && originalOpenRouter) {
    warnProblematicOpenRouterModel(openRouterModel());
    await runScenario("fake-gemini-valid-openrouter", {
      GEMINI_API_KEY: "fake-gemini-key",
      OPENROUTER_API_KEY: originalOpenRouter,
    }, {
      extractUsed: "openrouter",
      extractMethod: "ocr_rules_openrouter",
      insightsMethod: "openrouter",
      realProvider: true,
    });
  } else {
    console.log("fake-gemini-valid-openrouter: skipped (set SMOKE_REAL_AI=1 with OPENROUTER_API_KEY to run)");
  }

  console.log("AI provider smoke tests completed");
})().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
