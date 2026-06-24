const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const http = require("http");
const { spawn } = require("child_process");

if (!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run the schema and seed steps first.");
  process.exit(1);
}

const PORT = Number(process.env.SMOKE_PORT || 3397);
const BASE = `http://127.0.0.1:${PORT}`;
const runId = Date.now().toString(36);
const invoiceNumber = `SMOKE-${runId}`;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(`${BASE}/health`, (res) => {
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

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} ${res.status}: ${data.error || text || "request failed"}`);
  return data;
}

async function requestStatus(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

async function login(username, password) {
  const data = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return { token: data.token, auth: { Authorization: `Bearer ${data.token}` } };
}

(async () => {
  const child = spawn(process.execPath, ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), GEMINI_API_KEY: "", OPENROUTER_API_KEY: "" },
    stdio: "ignore",
  });

  const createdIds = [];
  let admin;
  try {
    await waitForServer();
    admin = await login("admin", "admin123");
    const reviewer = await login("reviewer", "review123");
    const manager = await login("manager", "manager123");
    const finance = await login("finance", "finance123");

    const text = [
      "Supplier: Smoke Supabase Pty Ltd",
      `Invoice Number: ${invoiceNumber}`,
      "Invoice Date: 2026-06-23",
      "VAT: R15.00",
      "Total: R115.00",
    ].join("\n");
    const dataBase64 = Buffer.from(text).toString("base64");

    const extracted = await request("/api/extract", {
      method: "POST",
      headers: admin.auth,
      body: JSON.stringify({ fileName: "smoke-supabase.pdf", mimeType: "application/pdf", dataBase64, documentType: "invoice" }),
    });
    if (!["ocr_rules", "ocr_rules_fallback"].includes(extracted.method)) throw new Error("no-key fallback extraction did not run");

    const doc = await request("/api/docs", {
      method: "POST",
      headers: admin.auth,
      body: JSON.stringify({
        type: "invoice",
        fileName: "smoke-supabase.pdf",
        fileMimeType: "application/pdf",
        fileHash: `smoke-${runId}`,
        extracted: extracted.extracted,
        extractionMeta: extracted,
      }),
    });
    createdIds.push(doc.id);

    const docs = await request("/api/docs", { headers: admin.auth });
    if (!docs.find((d) => d.id === doc.id)) throw new Error("saved document was not fetched from Supabase");

    const duplicate = await request("/api/docs", {
      method: "POST",
      headers: admin.auth,
      body: JSON.stringify({
        type: "invoice",
        fileName: "smoke-supabase-duplicate.pdf",
        fileMimeType: "application/pdf",
        fileHash: `smoke-${runId}-duplicate-file`,
        extracted: extracted.extracted,
        extractionMeta: extracted,
        isDup: false,
      }),
    });
    createdIds.push(duplicate.id);
    if (!duplicate.isDup) throw new Error("duplicate detection did not flag matching invoice number");

    await request(`/api/docs/${doc.id}/decide`, { method: "POST", headers: reviewer.auth, body: JSON.stringify({ action: "approve", comment: "smoke reviewer" }) });
    await request(`/api/docs/${doc.id}/decide`, { method: "POST", headers: manager.auth, body: JSON.stringify({ action: "approve", comment: "smoke manager" }) });
    await request(`/api/docs/${doc.id}/decide`, { method: "POST", headers: finance.auth, body: JSON.stringify({ action: "approve", comment: "smoke finance" }) });

    const afterApproval = await request("/api/docs", { headers: admin.auth });
    const approved = afterApproval.find((d) => d.id === doc.id);
    if (!approved || approved.status !== "approved" || approved.approvals.length !== 3) {
      throw new Error("3-step approval workflow did not complete");
    }

    const report = await request("/api/reports?status=approved", { headers: admin.auth });
    if (!report.find((d) => d.id === doc.id)) throw new Error("reports did not read approved Supabase data");

    const insights = await request("/api/insights", {
      method: "POST",
      headers: admin.auth,
      body: JSON.stringify({ filters: { vendor: "Smoke Supabase" } }),
    });
    if (!Array.isArray(insights.insights) || !insights.insights.length) throw new Error("insights fallback returned no data");

    const reviewerReports = await requestStatus("/api/reports", { headers: reviewer.auth });
    if (reviewerReports.status !== 403) throw new Error("reviewer reports access was not blocked");

    const financeReports = await requestStatus("/api/reports", { headers: finance.auth });
    if (financeReports.status !== 200) throw new Error("finance reports access was not allowed");

    const viewer = await login("viewer", "viewer123");
    const viewerUpload = await requestStatus("/api/extract", {
      method: "POST",
      headers: viewer.auth,
      body: JSON.stringify({ fileName: "viewer.pdf", mimeType: "application/pdf", dataBase64, documentType: "invoice" }),
    });
    if (viewerUpload.status !== 403) throw new Error("viewer upload access was not blocked");

    console.log("Supabase smoke test passed");
  } finally {
    if (admin) {
      for (const id of createdIds.reverse()) {
        await fetch(`${BASE}/api/docs/${id}`, { method: "DELETE", headers: admin.auth }).catch(() => {});
      }
    }
    child.kill();
  }
})().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
