import { useState, useEffect } from "react";
import * as XLSX from "xlsx";

/* ================================================================
   CONSTANTS
================================================================ */
const NAVY = "#0B1E3D";
const GOLD = "#C9A227";

// ── API base: uses env var in production, falls back to relative /api path in dev ──
const API_BASE = import.meta.env.VITE_API_URL || "";
const apiUrl = (path) => API_BASE ? `${API_BASE}${path}` : path;

async function readApiJson(res, fallback = "Request failed") {
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    const hint = text.trim().startsWith("<")
      ? "Unable to connect to the server. Please try again."
      : text.trim();
    throw new Error(hint || fallback);
  }

  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error || fallback);
  return data;
}

function userFromToken(token) {
  try {
    const raw = token.split(".")[1];
    if (!raw) return null;
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    return {
      id: payload.id || null,
      username: payload.username,
      role: payload.role,
      name: payload.name || payload.username,
      approvalStep: payload.approvalStep || null,
      stepLabel: payload.stepLabel || null,
    };
  } catch {
    return null;
  }
}

async function fetchServerDocs(token) {
  const res = await fetch(apiUrl("/api/docs"), { headers: { Authorization: `Bearer ${token}` } });
  return readApiJson(res, "Could not load documents");
}

const DEMO_USERS = [
  { username: "admin",    password: "admin123",   role: "admin",    name: "Admin User" },
  { username: "reviewer", password: "review123",  role: "approver", approvalStep: 1, stepLabel: "Reviewer",      name: "Sarah Naidoo" },
  { username: "manager",  password: "manager123", role: "approver", approvalStep: 2, stepLabel: "Manager",       name: "Mike Govender" },
  { username: "finance",  password: "finance123", role: "approver", approvalStep: 3, stepLabel: "Finance/Admin", name: "Finance Admin" },
  { username: "viewer",   password: "viewer123",  role: "viewer",   name: "Priya Pillay" },
];

const STATUS_META = {
  pending_approval_1: { label: "Pending – Reviewer",      color: "#92400e", bg: "#fef3c7" },
  pending_approval_2: { label: "Pending – Manager",       color: "#92400e", bg: "#fef3c7" },
  pending_approval_3: { label: "Pending – Finance/Admin", color: "#92400e", bg: "#fef3c7" },
  approved:           { label: "Approved",                color: "#065f46", bg: "#d1fae5" },
  rejected:           { label: "Rejected",                color: "#991b1b", bg: "#fee2e2" },
};

const STEP_LABELS = { 1: "Reviewer", 2: "Manager", 3: "Finance/Admin" };

const DEMO_DOCS = [
  { label: "Invoice – Takealot",    type: "invoice",     fileName: "takealot-inv-0341.pdf",     extracted: { vendor_name: "Takealot Online (Pty) Ltd", invoice_number: "TAK-2024-0341",  invoice_date: "2024-11-15", total_amount: 12540, vat_amount: 1632.17 } },
  { label: "Invoice – MTN",         type: "invoice",     fileName: "mtn-invoice-nov24.pdf",      extracted: { vendor_name: "MTN South Africa",          invoice_number: "MTN-INV-98234", invoice_date: "2024-11-28", total_amount: 3899,  vat_amount: 507.52  } },
  { label: "Credit Note – Makro",   type: "credit_note", fileName: "makro-cn0021.pdf",           extracted: { vendor_name: "Makro Retail (Pty) Ltd",    invoice_number: "CN-MAKRO-0021", invoice_date: "2024-12-03", total_amount: 7200,  vat_amount: 937.24  } },
  { label: "Invoice – Vodacom",     type: "invoice",     fileName: "vodacom-dec24.pdf",          extracted: { vendor_name: "Vodacom Business",          invoice_number: "VDB-2024-44412",invoice_date: "2024-12-10", total_amount: 5650,  vat_amount: 735.65  } },
  { label: "Duplicate Takealot", type: "invoice",     fileName: "takealot-inv-0341-copy.pdf", extracted: { vendor_name: "Takealot Online (Pty) Ltd", invoice_number: "TAK-2024-0341",  invoice_date: "2024-11-15", total_amount: 12540, vat_amount: 1632.17 } },
];

/* ================================================================
   IN-MEMORY STORE  (replace with a real DB for production scale)
================================================================ */
let _store = [];
const getDocs  = ()     => _store;
const setStore = (docs) => { _store = docs; };

/* ================================================================
   UTILITIES
================================================================ */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const R = (n) => {
  const v = Number(n);
  return isNaN(v) ? "—" : "R\u00a0" + v.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const stepOf = (status) => {
  const m = status?.match(/pending_approval_(\d)/);
  return m ? Number(m[1]) : null;
};

const isFinanceApprover = (user) => user?.role === "approver" && Number(user.approvalStep || 0) === 3;
const canViewReports = (user) => user?.role === "admin" || user?.role === "viewer" || isFinanceApprover(user);
const canViewInsights = (user) => canViewReports(user);

function canAccessView(user, view) {
  if (!user) return false;
  if (view === "upload") return user.role === "admin";
  if (view === "approvals") return user.role === "admin" || user.role === "approver";
  if (view === "reports") return canViewReports(user);
  if (view === "insights") return canViewInsights(user);
  return false;
}

function defaultViewForUser(user) {
  if (user?.role === "admin") return "upload";
  if (user?.role === "approver") return "approvals";
  if (canViewReports(user)) return "reports";
  return "reports";
}

function extractionMethodLabel(method = "") {
  if (method.includes("sample")) return "Sample document";
  if (method.includes("gemini") || method.includes("openrouter")) return "Enhanced extraction";
  if (method.includes("fallback") || method.includes("rules")) return "Document extraction";
  return method || "Extraction";
}

function insightCategory(text = "", index = 0) {
  const value = text.toLowerCase();
  if (value.includes("vat") || value.includes("tax")) return "VAT";
  if (value.includes("pending") || value.includes("approval") || value.includes("workflow")) return "Workflow";
  if (value.includes("vendor")) return "Vendor";
  if (value.includes("duplicate") || value.includes("outlier") || value.includes("anomaly")) return "Review";
  if (value.includes("date") || value.includes("month")) return "Timing";
  return ["Spend", "Risk", "Status"][index % 3];
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

async function sha256(file) {
  const buf  = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// LLM cleanup runs on the backend through Gemini when GEMINI_API_KEY is configured.

function dupCheck(extracted, hash, docs) {
  const active = docs.filter(d => d.status !== "rejected");
  if (hash) {
    const fd = active.find(d => d.fileHash === hash);
    if (fd) return { dup: true, reason: `Exact file already uploaded ("${fd.fileName}")` };
  }
  const inv = (extracted.invoice_number || "").trim().toLowerCase();
  if (inv) {
    const id = active.find(d => (d.extracted?.invoice_number || "").trim().toLowerCase() === inv);
    if (id) return { dup: true, reason: `Invoice #${extracted.invoice_number} already exists in the system` };
  }
  const vendor = (extracted.vendor_name || "").trim().toLowerCase();
  const amt    = Number(extracted.total_amount);
  if (vendor && amt > 0) {
    const sd = active.find(d =>
      (d.extracted?.vendor_name || "").trim().toLowerCase() === vendor &&
      Number(d.extracted?.total_amount) === amt
    );
    if (sd) return { dup: true, reason: "Same vendor and amount already on file — possible duplicate" };
  }
  return { dup: false, reason: null };
}

function dataUrlFromFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.onerror = () => rej(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

const INVOICE_KEYWORD_RE = /\b(supplier|vendor|invoice|credit\s*note|vat|tax|total|amount|date|bill\s*from|balance)\b/i;

function cleanEmbeddedText(raw) {
  return String(raw || "").replace(/\\[nrtbf()\\]/g, " ").replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasUsefulInvoiceText(text) {
  const clean = String(text || "").trim();
  return clean.length >= 20 && INVOICE_KEYWORD_RE.test(clean);
}

function textFromBytes(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  let raw = "";
  for (let i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);

  if (mimeType === "application/pdf") {
    const literal = [...raw.matchAll(/\(([^()]|\\.){3,}\)/g)].map(m => m[0].slice(1, -1)).join(" ");
    const hex = [...raw.matchAll(/<([0-9a-fA-F\s]{8,})>/g)].map(m => {
      try {
        const cleaned = m[1].replace(/\s+/g, "");
        let out = "";
        for (let i = 0; i < cleaned.length; i += 2) out += String.fromCharCode(parseInt(cleaned.slice(i, i + 2), 16));
        return out;
      } catch {
        return "";
      }
    }).join(" ");
    raw = `${literal} ${hex} ${raw.slice(0, 120000)}`;
    const cleaned = cleanEmbeddedText(raw);
    return hasUsefulInvoiceText(cleaned) ? cleaned : "";
  }

  return cleanEmbeddedText(raw);
}

async function embeddedText(file) {
  try {
    return textFromBytes(await file.arrayBuffer(), file.type);
  } catch {
    return "";
  }
}

let tesseractLoader = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoader) return tesseractLoader;
  tesseractLoader = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.async = true;
    s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("OCR library did not load"));
    s.onerror = () => reject(new Error("OCR library could not be loaded"));
    document.head.appendChild(s);
  });
  return tesseractLoader;
}

let pdfJsLoader = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfJsLoader) return pdfJsLoader;
  pdfJsLoader = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
    s.async = true;
    s.onload = () => {
      if (!window.pdfjsLib) {
        reject(new Error("PDF library did not load"));
        return;
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("PDF library could not be loaded"));
    document.head.appendChild(s);
  });
  return pdfJsLoader;
}

async function imageOcrText(file) {
  if (!file.type?.startsWith("image/")) return "";
  try {
    const Tesseract = await loadTesseract();
    const result = await Tesseract.recognize(file, "eng");
    return result?.data?.text || "";
  } catch {
    return "";
  }
}

async function pdfOcrText(file) {
  if (file.type !== "application/pdf") return "";
  try {
    const [pdfjsLib, Tesseract] = await Promise.all([loadPdfJs(), loadTesseract()]);
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pageCount = Math.min(pdf.numPages || 1, 2);
    const chunks = [];

    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const result = await Tesseract.recognize(canvas, "eng");
      chunks.push(result?.data?.text || "");
      canvas.width = 0;
      canvas.height = 0;
    }

    return chunks.join("\n");
  } catch {
    return "";
  }
}

function normalizeDocTypeClient(value) {
  const v = String(value || "").trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  if (["credit_note", "credit", "creditnote", "cn"].includes(v)) return "credit_note";
  if (["invoice", "inv"].includes(v)) return "invoice";
  return null;
}

function parseMoneyClient(value) {
  const match = String(value || "").replace(/zar|vat|total|amount|incl|r|:/gi, "").match(/-?\d[\d\s,]*(?:\.\d{1,2})?/);
  if (!match) return "";
  const n = Number(match[0].replace(/[\s,]/g, ""));
  return Number.isFinite(n) ? Number(n.toFixed(2)) : "";
}

function isoDateClient(value) {
  const raw = String(value || "");
  const ymd = raw.match(/\b(20\d{2}|19\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (ymd) return `${ymd[1]}-${String(ymd[2]).padStart(2, "0")}-${String(ymd[3]).padStart(2, "0")}`;
  const dmy = raw.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2}|19\d{2})\b/);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  return "";
}

function isValidIsoDateClient(value) {
  const iso = isoDateClient(value);
  if (!iso) return false;
  const [year, month, day] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isPositiveAmountClient(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function isOptionalNumericClient(value) {
  if (value === "" || value === null || value === undefined) return true;
  return Number.isFinite(Number(value));
}

function firstClient(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return (m[1] || m[0] || "").trim();
  }
  return "";
}

function ruleExtractClient(text, docType) {
  const clean = String(text || "").replace(/\r/g, "\n");
  const compact = clean.replace(/\s+/g, " ");
  const guessedType = /credit\s*note|credit\s*memo|\bcn[-\s#:]/i.test(compact) ? "credit_note" : /invoice|\binv[-\s#:]/i.test(compact) ? "invoice" : docType;
  const vendor = firstClient(clean, [
    /(?:vendor|supplier|from|bill\s*from)\s*[:#-]?\s*([A-Za-z0-9 &().,'/-]{3,80}?)(?=\s+(?:invoice|inv|document|doc|date|vat|tax|total|amount|balance)\b|$|\n)/i,
    /(?:vendor|supplier|from|bill\s*from)\s*[:#-]?\s*([^\n]{3,80})/i,
    /^([A-Z][A-Za-z0-9 &().,'/-]{2,80}(?:Pty|Ltd|Limited|Inc|LLC|SA|South Africa)[^\n]*)/m,
  ]);
  const invoiceNumber = firstClient(compact, [
    /(?:invoice|inv|document|doc|credit\s*note|cn)\s*(?:number|no|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{2,})/i,
    /(?:invoice|inv|document|doc|credit\s*note|cn)\s*[:#-]\s*([A-Z0-9][A-Z0-9/-]{2,})/i,
    /\b((?:INV|CN|CRN|TAX|DOC)[-\s]?[A-Z0-9-]{3,})\b/i,
  ]);
  const date = isoDateClient(firstClient(compact, [
    /(?:invoice|document|credit\s*note|tax)?\s*date\s*[:#-]?\s*([0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4})/i,
    /\b([0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2})\b/,
    /\b([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})\b/,
  ]));
  const total = parseMoneyClient(firstClient(compact, [
    /(?:grand\s*total|total\s*due|amount\s*due|total\s*amount|balance\s*due|total)\s*[:#-]?\s*(?:ZAR|R)?\s*(-?\d[\d\s,]*(?:\.\d{1,2})?)/i,
    /(?:ZAR|R)\s*(-?\d[\d\s,]*(?:\.\d{1,2})?)/i,
  ]));
  const vat = parseMoneyClient(firstClient(compact, [
    /(?:vat|tax)\s*(?:amount)?\s*[:#-]?\s*(?:ZAR|R)?\s*(-?\d[\d\s,]*(?:\.\d{1,2})?)/i,
  ]));
  const populated = [vendor, invoiceNumber, date, total, vat].filter(Boolean).length;
  return {
    extracted: { vendor_name: vendor, invoice_number: invoiceNumber, invoice_date: date, total_amount: total, vat_amount: vat, document_type: guessedType },
    method: "local_ocr_rules",
    confidence: Math.min(0.88, 0.2 + populated * 0.13),
    notes: populated ? "Local OCR/text rules extracted these fields. Review before submitting." : "No reliable text found. Fill in the fields manually before submitting.",
  };
}

async function aiExtract(file, docType = "invoice") {
  const [b64, dataUrl, text, imageText, pdfText] = await Promise.all([
    fileToBase64(file),
    dataUrlFromFile(file),
    embeddedText(file),
    imageOcrText(file),
    pdfOcrText(file),
  ]);
  const ocrText = [imageText, pdfText, text].filter(Boolean).join("\n");
  const token = localStorage.getItem("token");

  if (token) {
    const res = await fetch(apiUrl("/api/extract"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type,
        dataBase64: b64,
        ocrText,
        documentType: docType,
      }),
    });
      const data = await readApiJson(res, "The document could not be processed. Please try again.");
    return {
      extracted: { ...data.extracted, document_type: normalizeDocTypeClient(data.extracted?.document_type) || docType },
      meta: {
        method: data.extraction_method || data.method || "ocr_rules",
        confidence: data.extraction_confidence ?? data.confidence ?? 0,
        notes: data.extraction_notes || data.notes || "",
        aiProviderAttempted: data.ai_provider_attempted || [],
        aiProviderUsed: data.ai_provider_used || null,
      },
      preview: dataUrl,
    };
  }

  const local = ruleExtractClient(`${ocrText}\n${file.name}`, docType);
  return { extracted: local.extracted, meta: { method: local.method, confidence: local.confidence, notes: local.notes }, preview: dataUrl };
}

function fallbackInsights(docs) {
  if (!docs.length) return ["No submitted document records are available yet."];
  const byVendor = {}, byMonth = {};
  let total = 0, vat = 0;
  docs.forEach(d => {
    const vendor = d.extracted?.vendor_name || "Unknown";
    const amount = Number(d.extracted?.total_amount) || 0;
    total += amount;
    vat += Number(d.extracted?.vat_amount) || 0;
    byVendor[vendor] = (byVendor[vendor] || 0) + amount;
    const month = (d.extracted?.invoice_date || d.uploadDate || "").slice(0, 7) || "unknown";
    byMonth[month] = (byMonth[month] || 0) + amount;
  });
  const vendors = Object.entries(byVendor).sort((a, b) => b[1] - a[1]);
  const months = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
  const largest = [...docs].sort((a, b) => (Number(b.extracted?.total_amount) || 0) - (Number(a.extracted?.total_amount) || 0))[0];
  const avg = total / docs.length;
  const out = [`${docs.length} document(s) total ${R(total)}, including ${R(vat)} VAT.`];
  if (vendors[0]) out.push(`${vendors[0][0]} is the top vendor at ${R(vendors[0][1])}, ${total ? ((vendors[0][1] / total) * 100).toFixed(1) : 0}% of spend.`);
  if (largest && Number(largest.extracted?.total_amount) > avg * 1.6 && docs.length > 1) out.push(`${largest.extracted?.vendor_name || largest.fileName} is an anomaly candidate at ${R(largest.extracted?.total_amount)}.`);
  if (months.length > 1) out.push(`Spend moves from ${R(months[0][1])} in ${months[0][0]} to ${R(months[months.length - 1][1])} in ${months[months.length - 1][0]}.`);
  out.push(`${docs.filter(d => d.isDup).length} duplicate flag(s), ${docs.filter(d => String(d.status).startsWith("pending")).length} pending item(s), and ${docs.filter(d => d.status === "approved").length} approved item(s).`);
  return out;
}

async function aiInsights(docs) {
  const token = localStorage.getItem("token");
  if (!token) return fallbackInsights(docs);
  try {
    const res = await fetch(apiUrl("/api/insights"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ docs }),
    });
    const data = await readApiJson(res, "Insights failed");
    return Array.isArray(data.insights) ? data.insights : fallbackInsights(docs);
  } catch {
    return fallbackInsights(docs);
  }
}

/* ================================================================
   UI ATOMS
================================================================ */
function Badge({ status }) {
  const m = STATUS_META[status] || { label: status, color: "#374151", bg: "#f3f4f6" };
  return (
    <span style={{ color: m.color, backgroundColor: m.bg, fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 99, whiteSpace: "nowrap" }}>
      {m.label}
    </span>
  );
}

function ExportIcon({ type }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    style: { flexShrink: 0 },
  };
  if (type === "pdf") {
    return (
      <svg {...common}>
        <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
        <path d="M14 2v5h5" />
        <path d="M9 15h6" />
        <path d="M9 18h4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function EmptyApprovalState({ message }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, backgroundColor: "#fff", borderRadius: 10, padding: "14px 16px", border: "1px solid #e5e7eb", color: "#64748b", fontSize: 14 }}>
      <InfoIcon />
      <p style={{ margin: 0 }}>{message}</p>
    </div>
  );
}

function FilterField({ label, children }) {
  return (
    <div>
      <p style={{ fontSize: 12, fontWeight: 700, color: "#64748b", margin: "0 0 5px" }}>{label}</p>
      {children}
    </div>
  );
}

function Steps({ status, approvals = [] }) {
  const cur  = stepOf(status);
  const done = status === "approved";
  const rej  = status === "rejected";
  const rejectedStep = [...approvals].reverse().find(a => a.action === "reject")?.step || null;
  return (
    <div style={{ display: "flex", alignItems: "center", marginTop: 8 }}>
      {[1, 2, 3].map((s, i) => {
        const isApprovedStage = approvals.some(a => a.step === s && a.action === "approve");
        const isDone   = done || isApprovedStage || (cur !== null && s < cur);
        const isActive = cur === s && !rej;
        const isRej    = rej && rejectedStep === s;
        return (
          <div key={s} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{
                width: 24, height: 24, borderRadius: 99, border: "2px solid",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 700,
                borderColor:     isDone ? "#10b981" : isRej ? "#ef4444" : isActive ? NAVY : "#d1d5db",
                backgroundColor: isDone ? "#10b981" : isRej ? "#fff" : isActive ? "#fff" : "#f9fafb",
                color:           isDone ? "#fff" : isRej ? "#ef4444" : isActive ? NAVY : "#9ca3af",
              }}>
                {isDone ? "✓" : isRej ? "✗" : s}
              </div>
              <span style={{ fontSize: 9, marginTop: 2, fontWeight: 600, color: isDone ? "#10b981" : isRej ? "#ef4444" : isActive ? NAVY : "#9ca3af" }}>
                {STEP_LABELS[s].split("/")[0]}
              </span>
            </div>
            {i < 2 && <div style={{ width: 20, height: 2, backgroundColor: isDone ? "#10b981" : "#e5e7eb", margin: "0 2px", marginBottom: 14 }} />}
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================
   LOGIN
================================================================ */
function Login({ onLogin, error, loading }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");

  return (
    <>
    <style>{`
      .login-stage {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: Aptos, 'Segoe UI', Tahoma, sans-serif;
        background: #f4f6f8;
      }
      .login-grid { width: min(430px, calc(100vw - 48px)); display: grid; align-items: center; }
      .login-card { width: 100%; max-width: 430px; box-sizing: border-box; overflow: hidden; border-radius: 14px; padding: 30px; background: #fff; border: 1px solid #dfe5ec; box-shadow: 0 18px 42px rgba(15,23,42,0.10); }
      .login-card *, .login-card *::before, .login-card *::after { box-sizing: border-box; }
      .login-logo-wrap { display: flex; justify-content: center; width: 100%; max-width: 100%; margin: 0 0 18px; }
      .login-logo-frame { width: 100%; max-width: 260px; padding: 10px 12px; border-radius: 10px; background: #f8fafc; border: 1px solid #e5e7eb; overflow: hidden; }
      .login-logo-frame img { display: block; width: 100%; max-width: 100%; height: auto; margin: 0 auto; }
      .login-form { width: 100%; max-width: 100%; min-width: 0; }
      .form-heading { margin-bottom: 22px; text-align: left; }
      .form-heading h2 { margin: 0; color: #10223f; letter-spacing: -0.02em; font-size: 26px; }
      .form-heading p { color: #64748b; margin: 6px 0 0; font-size: 14px; }
      .form-row { width: 100%; max-width: 100%; margin: 0 0 15px; }
      .form-row label { display: block; color: #475569; font-size: 13px; font-weight: 700; margin-bottom: 7px; }
      .form-row input { display: block; width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; margin: 0; border: 1px solid #cfd8e3; background: #fff; border-radius: 8px; padding: 12px 13px; color: #10223f; }
      .primary-action { display: block; width: 100%; max-width: 100%; box-sizing: border-box; margin: 0; padding: 12px 20px; border-radius: 8px; background: #0B1E3D; color: #fff; border: none; font-weight: 800; cursor: pointer; box-shadow: none; }
      .login-form .form-row input, .login-form .primary-action { display: block; width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; margin-left: 0; margin-right: 0; }
      .login-form .form-row input:focus { outline: none; border-color: #0B1E3D; box-shadow: inset 0 0 0 1px #0B1E3D; }
      .primary-action:disabled { opacity: .65; cursor: wait; }
      .alert-error { color: #b91c1c; background: #fff1f2; border: 1px solid #fecdd3; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
      .demo-account-panel { width: 100%; max-width: 100%; margin-top: 20px; padding-top: 16px; border-top: 1px solid #e5e7eb; }
      .demo-account-panel > p { margin: 0 0 10px; color: #64748b; font-size: 13px; font-weight: 700; }
      .demo-account-list { display: grid; gap: 8px; }
      .demo-account { width: 100%; max-width: 100%; box-sizing: border-box; display: flex; justify-content: space-between; gap: 12px; align-items: center; margin: 0; border: 1px solid #e5e7eb; background: #f8fafc; border-radius: 8px; padding: 9px 11px; cursor: pointer; text-align: left; }
      .demo-account b { display: block; color: #10223f; }
      .demo-account small { color: #64748b; }
      .demo-account em { color: #475569; font-style: normal; font-size: 11px; font-weight: 800; }
      @media (max-width: 640px) { .login-stage { padding: 18px; } .login-card { padding: 22px; } }
    `}</style>
    <div className="login-stage">
      <div className="login-grid">
        <section className="login-card">
          <div className="login-logo-wrap">
            <div className="login-logo-frame">
              <img src="/mindrift-logo.png" alt="MindRift logo" />
            </div>
          </div>
          <div className="form-heading">
            <h2>DocFlow AI</h2>
            <p>Sign in to the document approval workspace.</p>
          </div>
          <div className="login-form">
            {[["Username", u, setU, "username", "text", "e.g. admin"], ["Password", p, setP, "current-password", "password", ""]].map(([lbl, val, set, ac, type, ph]) => (
              <div key={lbl} className="form-row">
                <label>{lbl}</label>
                <input type={type} value={val} onChange={e => set(e.target.value)} onKeyDown={e => e.key === "Enter" && onLogin(u, p)}
                  placeholder={ph} autoComplete={ac} />
              </div>
            ))}
            {error && <p className="alert-error">{error}</p>}
            <button className="primary-action" onClick={() => onLogin(u, p)} disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </div>

          <div className="demo-account-panel">
            <p>Available sign-ins</p>
            <div className="demo-account-list">
              {DEMO_USERS.map(du => (
                <button key={du.username} onClick={() => { setU(du.username); setP(du.password); }} className="demo-account">
                  <span><b>{du.username}</b><small>{du.password}</small></span>
                  <em>{du.stepLabel || du.role}</em>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
    </>
  );
}

/* ================================================================
   NAV  (bottom bar mobile / sidebar desktop)
================================================================ */
function Nav({ user, view, setView, onLogout, docs }) {
  const pending = user.role === "admin"
    ? docs.filter(d => d.status.startsWith("pending")).length
    : user.role === "approver"
      ? docs.filter(d => stepOf(d.status) === user.approvalStep).length
      : 0;
  const tabs = [
    { key: "upload",    label: "Upload",    roles: ["admin", "approver"] },
    { key: "approvals", label: "Approvals", roles: ["admin", "approver"], badge: pending || null },
    { key: "reports",   label: "Reports",   roles: ["admin", "approver", "viewer"] },
    { key: "insights",  label: "Insights",  roles: ["admin", "approver", "viewer"] },
  ].filter(t => canAccessView(user, t.key));

  return (
    <>
      {/* Mobile bottom nav */}
      <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100, backgroundColor: "#fff", borderTop: "1px solid #e5e7eb", display: "flex", boxShadow: "0 -4px 20px rgba(0,0,0,0.08)" }} className="mobile-nav">
        {tabs.map(t => {
          const active = view === t.key;
          return (
            <button key={t.key} onClick={() => setView(t.key)}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "8px 4px 10px", border: "none", background: "none", cursor: "pointer", color: active ? NAVY : "#9ca3af", position: "relative" }}>
              {t.badge && <span style={{ position: "absolute", top: 6, right: "calc(50% - 16px)", backgroundColor: "#334155", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 99, minWidth: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px" }}>{t.badge}</span>}
              <span style={{ fontSize: 11, fontWeight: active ? 700 : 500, marginTop: 3 }}>{t.label}</span>
              {active && <div style={{ position: "absolute", bottom: 0, left: "25%", right: "25%", height: 2, backgroundColor: NAVY, borderRadius: 2 }} />}
            </button>
          );
        })}
        <button onClick={onLogout} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "8px 4px 10px", border: "none", background: "none", cursor: "pointer", color: "#9ca3af" }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>←</span>
          <span style={{ fontSize: 10, marginTop: 3 }}>Logout</span>
        </button>
      </nav>

      {/* Desktop sidebar */}
      <aside style={{ width: 184, minHeight: "100vh", backgroundColor: NAVY, display: "flex", flexDirection: "column", flexShrink: 0 }} className="desktop-nav">
        <div style={{ padding: "20px 16px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <p style={{ color: "#fff", fontSize: 18, fontWeight: 800, margin: "0 0 2px", letterSpacing: -0.2 }}>DocFlow AI</p>
          <p style={{ color: "rgba(255,255,255,0.42)", fontSize: 11, margin: "0 0 14px" }}>PCG | MindRift</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 99, backgroundColor: "rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: "#fff", flexShrink: 0 }}>{user.name.charAt(0)}</div>
            <div>
              <p style={{ color: "#fff", fontSize: 13, fontWeight: 600, margin: 0 }}>{user.name}</p>
              <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 11, margin: 0 }}>{user.stepLabel || user.role}</p>
            </div>
          </div>
        </div>
        <nav style={{ flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 2 }}>
          {tabs.map(t => {
            const active = view === t.key;
            return (
              <button key={t.key} onClick={() => setView(t.key)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderRadius: 8, border: "none", cursor: "pointer", backgroundColor: active ? "rgba(255,255,255,0.11)" : "transparent", color: active ? "#fff" : "rgba(255,255,255,0.64)", fontWeight: active ? 700 : 500, fontSize: 13 }}>
                <span>{t.label}</span>
                {t.badge && <span style={{ backgroundColor: active ? "#fff" : "rgba(255,255,255,0.12)", color: active ? NAVY : "#fff", fontSize: 10, fontWeight: 700, borderRadius: 99, minWidth: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>{t.badge}</span>}
              </button>
            );
          })}
        </nav>
        <div style={{ padding: "12px 12px 20px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <button onClick={onLogout} style={{ width: "100%", padding: "9px 14px", borderRadius: 12, border: "none", background: "none", color: "rgba(255,255,255,0.4)", fontSize: 13, cursor: "pointer", textAlign: "left" }}>← Log out</button>
        </div>
      </aside>
    </>
  );
}

/* ================================================================
   STATS
================================================================ */
function Stats({ docs }) {
  const items = [
    { label: "Pending",    value: docs.filter(d => d.status.startsWith("pending")).length, color: NAVY },
    { label: "Approved",   value: docs.filter(d => d.status === "approved").length,         color: "#047857" },
    { label: "Rejected",   value: docs.filter(d => d.status === "rejected").length,         color: "#b91c1c" },
    { label: "Duplicates", value: docs.filter(d => d.isDup).length,                         color: "#475569" },
  ];
  return (
    <div className="stats-grid">
      {items.map(s => (
        <div key={s.label} style={{ backgroundColor: "#fff", borderRadius: 10, padding: "12px 14px", border: "1px solid #e5e7eb", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}>
          <p style={{ color: "#64748b", fontSize: 12, margin: "0 0 4px", fontWeight: 600 }}>{s.label}</p>
          <p style={{ color: s.color, fontSize: 22, fontWeight: 800, margin: 0, lineHeight: 1.1 }}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}

/* ================================================================
   UPLOAD
================================================================ */
function Upload({ user, docs, onUpdate }) {
  const [docType,    setDocType]    = useState("invoice");
  const [file,       setFile]       = useState(null);
  const [hash,       setHash]       = useState(null);
  const [extracted,  setExtracted]  = useState(null);
  const [extractionMeta, setExtractionMeta] = useState(null);
  const [dup,        setDup]        = useState(null);
  const [override,   setOverride]   = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [submitted,  setSubmitted]  = useState(false);
  const [error,      setError]      = useState("");
  const [drag,       setDrag]       = useState(false);

  function reset() { setFile(null); setHash(null); setExtracted(null); setExtractionMeta(null); setDup(null); setOverride(false); setError(""); }

  async function processFile(f) {
    if (!f) return;
    if (!["application/pdf", "image/jpeg", "image/jpg", "image/png"].includes(f.type)) { setError("Only PDF, JPG, or PNG accepted."); return; }
    reset(); setFile(f); setSubmitted(false); setExtracting(true);
    try {
      const h = await sha256(f);
      setHash(h);
      const data = await aiExtract(f, docType);
      const normalized = { ...data.extracted, document_type: data.extracted?.document_type || docType };
      setExtracted(normalized);
      setExtractionMeta(data.meta || null);
      setDup(dupCheck(normalized, h, docs));
    } catch (e) { setError("The document could not be processed. Please try again."); }
    finally { setExtracting(false); }
  }

  function loadDemo(d) {
    reset(); setSubmitted(false);
    setFile({ name: d.fileName });
    setHash("demo-" + uid());
    setExtracted({ ...d.extracted, document_type: d.type });
    setExtractionMeta({ method: "sample_document", confidence: 1, notes: "Sample document details loaded for review before submission." });
    setDocType(d.type);
    setDup(dupCheck(d.extracted, null, docs));
  }

  async function submit() {
    if (dup?.dup && !override) return;
    setSaving(true); setError("");
    try {
      const token = localStorage.getItem("token");
      if (token) {
        const res = await fetch(apiUrl("/api/docs"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ type: docType, fileName: file?.name || "document.pdf", fileMimeType: file?.type || "application/pdf", fileHash: hash, extracted: { ...extracted, document_type: docType }, extractionMeta, isDup: dup?.dup || false, dupReason: dup?.reason || null }) });
        const saved = await readApiJson(res, "The document could not be submitted. Please try again.");
        const updated = [...docs, saved]; setStore(updated); onUpdate(updated); setSubmitted(true); reset();
      } else {
        const doc = { id: uid(), type: docType, fileName: file?.name || "document.pdf", fileMimeType: file?.type || "application/pdf", fileHash: hash, uploadedBy: user.name, uploadDate: new Date().toISOString(), extracted: { ...extracted, document_type: docType }, extractionMeta, status: "pending_approval_1", isDup: dup?.dup || false, dupReason: dup?.reason || null, approvals: [] };
        const updated = [...docs, doc]; setStore(updated); onUpdate(updated); setSubmitted(true); reset();
      }
    } catch (e) { setError("The document could not be submitted. Please try again."); }
    finally { setSaving(false); }
  }

  const validationIssues = [];
  if (extracted) {
    if (!String(extracted.vendor_name || "").trim()) validationIssues.push("vendor");
    if (!String(extracted.invoice_number || "").trim()) validationIssues.push("invoice number");
    if (!isValidIsoDateClient(extracted.invoice_date)) validationIssues.push("valid date");
    if (!isPositiveAmountClient(extracted.total_amount)) validationIssues.push("amount greater than 0");
    if (!isOptionalNumericClient(extracted.vat_amount)) validationIssues.push("numeric VAT");
  }
  const requiredReady = extracted && validationIssues.length === 0;
  const canSubmit = requiredReady && !extracting && (!dup?.dup || override);
  const inp = { width: "100%", border: "1.5px solid #e5e7eb", borderRadius: 12, padding: "11px 14px", fontSize: 15, outline: "none", boxSizing: "border-box", backgroundColor: "#f9fafb" };
  const lbl = { display: "block", fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 };

  return (
      <div className="page-shell page-enter">
      <div className="page-header">
        <h2>Upload Document</h2>
        <p>Upload an invoice or credit note, or use a sample document to review extraction, duplicate checks, and approval routing.</p>
      </div>

      <div className="premium-card intake-console" style={{ backgroundColor: "#fff", borderRadius: 20, padding: 20, border: "1px solid #f3f4f6", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
        {/* Type toggle */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {[["invoice", "Invoice"], ["credit_note", "Credit Note"]].map(([val, lbl_]) => (
            <button key={val} onClick={() => { setDocType(val); setExtracted(p => p ? { ...p, document_type: val } : p); }}
              style={{ flex: 1, padding: 12, borderRadius: 12, border: "2px solid", borderColor: docType === val ? NAVY : "#e5e7eb", backgroundColor: docType === val ? NAVY : "#fff", color: docType === val ? "#fff" : "#9ca3af", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
              {lbl_}
            </button>
          ))}
        </div>

        {/* Drop zone */}
        <div className={`upload-dropzone ${drag ? "is-dragging" : ""}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); processFile(e.dataTransfer.files[0]); }}
          onClick={() => document.getElementById("fu").click()}
          style={{ border: `2px dashed ${drag ? "#f59e0b" : "#d1d5db"}`, borderRadius: 16, padding: 28, textAlign: "center", cursor: "pointer", backgroundColor: drag ? "#fffbeb" : "#fafafa", transition: "all 0.15s", marginBottom: 16 }}>
          <p style={{ color: "#374151", fontWeight: 600, fontSize: 14, margin: 0 }}>{file ? file.name : "Drop file here or tap to browse"}</p>
          <p style={{ color: "#64748b", fontSize: 12, margin: "4px 0 0" }}>PDF, JPG, or PNG</p>
          <input id="fu" type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => processFile(e.target.files[0])} style={{ display: "none" }} />
        </div>

        {/* Demo strip */}
        <div className="demo-strip" style={{ backgroundColor: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, marginBottom: 16 }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: "#475569", margin: "0 0 8px" }}>Sample documents</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {DEMO_DOCS.map((d, i) => (
              <button key={i} onClick={() => loadDemo(d)}
                style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, border: "1px solid #cbd5e1", backgroundColor: "#fff", color: NAVY, fontWeight: 600, cursor: "pointer" }}>
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {extracting && <div style={{ display: "flex", alignItems: "center", gap: 10, backgroundColor: "#f8fafc", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}><span style={{ color: "#64748b", fontSize: 13 }}>Processing document...</span></div>}
        {error    && <div style={{ backgroundColor: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 12, padding: "12px 16px", color: "#dc2626", fontSize: 14, marginBottom: 12 }}>{error}</div>}
        {submitted && <div style={{ backgroundColor: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 8, padding: "10px 12px", color: "#065f46", fontSize: 14, marginBottom: 12 }}>Submitted - awaiting Reviewer approval (Step 1 of 3)</div>}

        {extracted && (
          <div className="extraction-console" style={{ borderTop: "1px solid #f3f4f6", marginTop: 16, paddingTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
              <p style={{ fontWeight: 800, fontSize: 16, color: NAVY, margin: 0 }}>Extracted data</p>
              <p style={{ color: "#9ca3af", fontSize: 12, margin: 0 }}>Review and confirm details</p>
            </div>

            {extractionMeta && (
              <div className="extraction-meta" style={{ backgroundColor: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 12px", marginBottom: 14 }}>
                <div className="meta-row">
                  <span className="method-badge">{extractionMethodLabel(extractionMeta.method)}</span>
                  {typeof extractionMeta.confidence === "number" && <span className="confidence-pill">{Math.round(extractionMeta.confidence * 100)}% confidence</span>}
                </div>
                {extractionMeta.notes && <p style={{ color: "#64748b", fontSize: 12, margin: 0, lineHeight: 1.5 }}>{extractionMeta.notes}</p>}
              </div>
            )}

            {dup?.dup && (
              <div style={{ backgroundColor: "#fff8f1", border: "1px solid #fdba74", borderRadius: 10, padding: 14, marginBottom: 16 }}>
                <p style={{ fontWeight: 700, color: "#9a3412", fontSize: 14, margin: "0 0 4px" }}>Possible duplicate found</p>
                <p style={{ color: "#9a3412", fontSize: 13, margin: "0 0 12px" }}>{dup.reason}</p>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "#7c2d12", fontWeight: 600 }}>
                  <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} style={{ width: 16, height: 16, accentColor: "#ea580c" }} />
                  Confirm this document should continue
                </label>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>Document type</label>
              <select value={extracted.document_type || docType} onChange={e => { setDocType(e.target.value); setExtracted(p => ({ ...p, document_type: e.target.value })); }} style={inp}>
                <option value="invoice">Invoice</option>
                <option value="credit_note">Credit Note</option>
              </select>
            </div>

            {[["Vendor", "vendor_name", "text"], ["Invoice number", "invoice_number", "text"], ["Date", "invoice_date", "date"], ["Amount (ZAR)", "total_amount", "number"], ["VAT (ZAR)", "vat_amount", "number"]].map(([label, key, type]) => (
              <div key={key} style={{ marginBottom: 14 }}>
                <label style={lbl}>{label}</label>
                <input type={type} value={extracted[key] ?? ""} onChange={e => setExtracted(p => ({ ...p, [key]: e.target.value }))} style={inp} />
              </div>
            ))}

            {!!validationIssues.length && (
              <div style={{ backgroundColor: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: "10px 12px", color: "#c2410c", fontSize: 12, marginBottom: 12 }}>
                Complete: {validationIssues.join(", ")}.
              </div>
            )}

            <button className="primary-action submit-action" onClick={submit} disabled={!canSubmit || saving}
              style={{ width: "100%", padding: 15, borderRadius: 14, border: "none", backgroundColor: (canSubmit && !saving) ? NAVY : "#e5e7eb", color: (canSubmit && !saving) ? "#fff" : "#9ca3af", fontSize: 15, fontWeight: 700, cursor: (canSubmit && !saving) ? "pointer" : "not-allowed", marginTop: 4 }}>
              {saving ? "Submitting…" : "Confirm & Submit for Approval →"}
            </button>
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ================================================================
   DOC CARD
================================================================ */
function DocCard({ d, canAct, comments, setComments, busyId, busyAction, onDecision }) {
  const [expanded, setExpanded] = useState(canAct);
  const [confirmReject, setConfirmReject] = useState(false);
  return (
    <div className="workflow-card" style={{ backgroundColor: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", boxShadow: "0 1px 2px rgba(15,23,42,0.04)", marginBottom: 10, overflow: "hidden" }}>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontWeight: 700, fontSize: 15, color: NAVY, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.extracted?.vendor_name || "Unknown vendor"}</p>
            <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0 0" }}>
              {d.type === "invoice" ? "Invoice" : "Credit Note"}
              {d.extracted?.invoice_number ? " · #" + d.extracted.invoice_number : ""}
              {d.extracted?.invoice_date   ? " · " + d.extracted.invoice_date   : ""}
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
            <p style={{ fontWeight: 800, fontSize: 16, color: NAVY, margin: 0 }}>{R(d.extracted?.total_amount)}</p>
            <Badge status={d.status} />
          </div>
        </div>

        <Steps status={d.status} approvals={d.approvals} />

        {d.isDup && <div style={{ backgroundColor: "#fff8f1", border: "1px solid #fdba74", borderRadius: 8, padding: "8px 10px", marginTop: 10 }}><p style={{ color: "#9a3412", fontSize: 12, margin: 0 }}>{d.dupReason}</p></div>}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
          <p style={{ color: "#d1d5db", fontSize: 11, margin: 0 }}>By {d.uploadedBy} · {new Date(d.uploadDate).toLocaleDateString()}</p>
          {d.approvals.length > 0 && <button onClick={() => setExpanded(x => !x)} style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 11, cursor: "pointer", padding: 0, fontWeight: 600 }}>{expanded ? "Hide ▲" : `History (${d.approvals.length}) ▼`}</button>}
        </div>

        {expanded && d.approvals.length > 0 && (
          <div style={{ borderTop: "1px solid #f9fafb", marginTop: 8, paddingTop: 8 }}>
            {d.approvals.map((a, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                <span style={{ color: a.action === "approve" ? "#10b981" : "#ef4444", fontSize: 12, flexShrink: 0 }}>{a.action === "approve" ? "✓" : "✗"}</span>
                <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>
                  <b style={{ color: "#374151" }}>{STEP_LABELS[a.step]}</b> · {a.approverName}
                  {a.comment ? <span style={{ color: "#9ca3af" }}> — "{a.comment}"</span> : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {canAct && (
        <div style={{ borderTop: "1px solid #e5e7eb", backgroundColor: "#f8fafc", padding: 12 }}>
          <input placeholder="Comment (required to reject)" value={comments[d.id] || ""} onChange={e => { setConfirmReject(false); setComments(c => ({ ...c, [d.id]: e.target.value })); }}
            style={{ width: "100%", border: "1px solid #cfd8e3", borderRadius: 8, padding: "9px 11px", fontSize: 13, outline: "none", boxSizing: "border-box", backgroundColor: "#fff", marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => onDecision(d, "approve")} disabled={busyId === d.id}
              style={{ width: 124, padding: "8px 12px", borderRadius: 8, border: "none", backgroundColor: "#047857", color: "#fff", fontWeight: 700, fontSize: 13, cursor: busyId === d.id ? "wait" : "pointer", opacity: busyId === d.id ? 0.6 : 1 }}>
              {busyId === d.id && busyAction === "approve" ? "Approving..." : "Approve"}
            </button>
            <button onClick={() => confirmReject ? onDecision(d, "reject") : setConfirmReject(true)} disabled={busyId === d.id || !comments[d.id]?.trim()}
              style={{ width: 124, padding: "8px 12px", borderRadius: 8, border: "1px solid #fecaca", backgroundColor: "#fff", color: "#b91c1c", fontWeight: 700, fontSize: 13, cursor: (busyId === d.id || !comments[d.id]?.trim()) ? "not-allowed" : "pointer", opacity: (busyId === d.id || !comments[d.id]?.trim()) ? 0.45 : 1 }}>
              {busyId === d.id && busyAction === "reject" ? "Rejecting..." : confirmReject ? "Confirm" : "Reject"}
            </button>
          </div>
          {!comments[d.id]?.trim() && <p style={{ textAlign: "right", fontSize: 11, color: "#94a3b8", margin: "6px 0 0" }}>Add a comment to enable rejection</p>}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   APPROVALS
================================================================ */
function Approvals({ user, docs, onUpdate }) {
  const [busyId,   setBusyId]   = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const [comments, setComments] = useState({});
  const [error,    setError]    = useState("");

  const canAct = s => user.role === "admin" || (user.role === "approver" && user.approvalStep === s);
  const open   = docs.filter(d => d.status !== "approved" && d.status !== "rejected");
  const mine   = open.filter(d => { const s = stepOf(d.status); return s && canAct(s); });
  const others = user.role === "admin" ? open.filter(d => { const s = stepOf(d.status); return s && !canAct(s); }) : [];
  const closed = user.role === "admin" ? docs.filter(d => d.status === "approved" || d.status === "rejected") : [];
  const emptyApprovalMessage = user.role === "approver" && mine.length === 0
    ? user.approvalStep === 1
      ? "No documents are currently awaiting reviewer approval."
      : user.approvalStep === 2
        ? "No documents are currently awaiting manager approval."
        : user.approvalStep === 3
          ? "No documents are currently awaiting final approval."
          : "No approvals are currently pending."
    : docs.length === 0
      ? "No approvals are currently pending."
      : "";

  async function decide(doc, action) {
    const step = stepOf(doc.status);
    if (!step || (action === "reject" && !comments[doc.id]?.trim())) return;
    setBusyId(doc.id); setBusyAction(action); setError("");
    try {
      const token = localStorage.getItem("token");
      if (token) {
        const res = await fetch(apiUrl(`/api/docs/${doc.id}/decide`), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, comment: comments[doc.id] || "" }) });
        await readApiJson(res, "The decision could not be saved. Please try again.");
        const j = await fetchServerDocs(token); setStore(j); onUpdate(j);
      } else {
        const entry = { step, approverName: user.name, approverRole: user.stepLabel || user.role, action, comment: comments[doc.id] || "", timestamp: new Date().toISOString() };
        const updated = docs.map(d => {
          if (d.id !== doc.id) return d;
          const status = action === "reject" ? "rejected" : step < 3 ? `pending_approval_${step + 1}` : "approved";
          return { ...d, status, approvals: [...d.approvals, entry] };
        });
        setStore(updated); onUpdate(updated);
      }
      setComments(c => { const n = { ...c }; delete n[doc.id]; return n; });
    } catch (e) { setError("The decision could not be saved. Please try again."); }
    finally { setBusyId(null); setBusyAction(null); }
  }

  const renderSection = (title, items, act) => items.length === 0 ? null : (
    <div style={{ marginBottom: 24 }}>
      <p style={{ fontSize: 13, fontWeight: 700, color: "#64748b", margin: "0 0 10px" }}>{title} ({items.length})</p>
      {items.map(d => <DocCard key={d.id} d={d} canAct={act} comments={comments} setComments={setComments} busyId={busyId} busyAction={busyAction} onDecision={decide} />)}
    </div>
  );

  return (
    <div className="page-shell page-enter">
      <div className="page-header">
        <h2>Approvals</h2>
        <p>{user.role === "admin" ? "Monitor and act across Reviewer, Manager, and Finance stages." : `Step ${user.approvalStep} of 3 - ${user.stepLabel}`}</p>
      </div>
      <h2 style={{ display: "none" }}>Approvals</h2>
      <p style={{ color: "#9ca3af", fontSize: 13, margin: "0 0 20px" }}>{user.role === "admin" ? "You can act at any step." : `Step ${user.approvalStep} of 3 — ${user.stepLabel}`}</p>
      {error && <div style={{ backgroundColor: "#fee2e2", borderRadius: 12, padding: "12px 16px", color: "#dc2626", fontSize: 14, marginBottom: 16 }}>{error}</div>}
      {emptyApprovalMessage && <EmptyApprovalState message={emptyApprovalMessage} />}
      {renderSection("Awaiting your decision", mine, true)}
      {renderSection("Waiting on others", others, false)}
      {renderSection("Closed", closed, false)}
    </div>
  );
}

/* ================================================================
   REPORTS
================================================================ */
function Reports({ docs, user, onUpdate }) {
  const [from, setFrom] = useState(""); const [to,   setTo]   = useState("");
  const [vend, setVend] = useState(""); const [stat, setStat] = useState("all");
  const [type, setType] = useState("all");
  const [minA, setMinA] = useState(""); const [maxA, setMaxA] = useState("");
  const [tab,  setTab]  = useState("spend");
  const [delId,setDelId]= useState(null);
  const [exporting, setExporting] = useState("");

  const rows = docs.filter(d => {
    const amt  = Number(d.extracted?.total_amount) || 0;
    const date = d.extracted?.invoice_date || d.uploadDate.slice(0, 10);
    if (from && date < from) return false;
    if (to   && date > to)   return false;
    if (vend && !(d.extracted?.vendor_name || "").toLowerCase().includes(vend.toLowerCase())) return false;
    if (stat === "pending"  && !d.status.startsWith("pending")) return false;
    if (stat === "approved" && d.status !== "approved")         return false;
    if (stat === "rejected" && d.status !== "rejected")         return false;
    if (type === "invoice"     && d.type !== "invoice")         return false;
    if (type === "credit_note" && d.type !== "credit_note")     return false;
    if (minA && amt < Number(minA)) return false;
    if (maxA && amt > Number(maxA)) return false;
    return true;
  });

  const total    = rows.reduce((s, d) => s + (Number(d.extracted?.total_amount) || 0), 0);
  const totalVat = rows.reduce((s, d) => s + (Number(d.extracted?.vat_amount)   || 0), 0);
  const excl     = total - totalVat;
  const byVendor = {};
  rows.forEach(d => { const v = d.extracted?.vendor_name || "Unknown"; byVendor[v] = (byVendor[v] || 0) + (Number(d.extracted?.total_amount) || 0); });

  async function exportXlsx() {
    if (exporting) return;
    setExporting("excel");
    await new Promise(requestAnimationFrame);
    const data = rows.map(d => ({
      "Type": d.type === "invoice" ? "Invoice" : "Credit Note", "File": d.fileName,
      "Vendor": d.extracted?.vendor_name || "", "Invoice #": d.extracted?.invoice_number || "",
      "Date": d.extracted?.invoice_date || "", "Amount": Number(d.extracted?.total_amount) || 0,
      "VAT": Number(d.extracted?.vat_amount) || 0,
      "Excl VAT": (Number(d.extracted?.total_amount) || 0) - (Number(d.extracted?.vat_amount) || 0),
      "Status": STATUS_META[d.status]?.label || d.status, "Duplicate": d.isDup ? "Yes" : "No",
      "By": d.uploadedBy, "Uploaded": d.uploadDate.slice(0, 10),
      "Trail": d.approvals.map(a => `${STEP_LABELS[a.step]}: ${a.action}`).join(" | "),
    }));
    const ws = XLSX.utils.json_to_sheet(data), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Report");
    XLSX.writeFile(wb, "docflow-report.xlsx");
    setTimeout(() => setExporting(""), 250);
  }

  function exportPdf() {
    if (exporting) return;
    setExporting("pdf");
    setTimeout(() => {
      window.print();
      setExporting("");
    }, 100);
  }

  async function del(id) {
    if (!window.confirm("Delete this document?")) return;
    setDelId(id);
    try {
      const token = localStorage.getItem("token");
      if (token) {
        const res = await fetch(apiUrl(`/api/docs/${id}`), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
        await readApiJson(res, "The document could not be deleted. Please try again.");
        const j = await fetchServerDocs(token); setStore(j); onUpdate(j);
      } else {
        const updated = docs.filter(d => d.id !== id);
        setStore(updated); onUpdate(updated);
      }
    } catch (e) {
      alert("The document could not be deleted. Please try again.");
    } finally { setDelId(null); }
  }

  const sel = { width: "100%", border: "1.5px solid #e5e7eb", borderRadius: 10, padding: "9px 12px", fontSize: 13, outline: "none", backgroundColor: "#f9fafb", boxSizing: "border-box" };
  const TABS = [{ key: "spend", label: "Spend" }, { key: "vendor", label: "Vendors" }, { key: "vat", label: "VAT" }, { key: "list", label: "Documents" }];

  return (
    <div className="page-shell page-enter reports-page">
      <style>{`@media print { .noprint { display:none!important; } }`}</style>
      <div className="noprint">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div className="page-header compact">
              <h2>Reports</h2>
              <p>Filter submitted documents, export results, and review spend visibility.</p>
            </div>
            <h2 style={{ display: "none" }}>Reports</h2>
            <p style={{ color: "#9ca3af", fontSize: 13, margin: "2px 0 0" }}>{rows.length} document{rows.length !== 1 ? "s" : ""} match filters</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={exportXlsx} disabled={!!exporting} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: "none", backgroundColor: NAVY, color: "#fff", fontWeight: 700, fontSize: 13, cursor: exporting ? "wait" : "pointer", opacity: exporting ? 0.7 : 1 }}><ExportIcon type="excel" />{exporting === "excel" ? "Exporting..." : "Excel"}</button>
            <button onClick={exportPdf} disabled={!!exporting} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: `1.5px solid ${NAVY}`, backgroundColor: "#fff", color: NAVY, fontWeight: 700, fontSize: 13, cursor: exporting ? "wait" : "pointer", opacity: exporting ? 0.7 : 1 }}><ExportIcon type="pdf" />{exporting === "pdf" ? "Exporting..." : "PDF"}</button>
          </div>
        </div>

        <div className="filter-panel premium-card" style={{ backgroundColor: "#fff", borderRadius: 16, padding: 16, border: "1px solid #f3f4f6", marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 10 }}>
            <FilterField label="From"><input type="date" value={from} onChange={e => setFrom(e.target.value)} style={sel} /></FilterField>
            <FilterField label="To"><input type="date" value={to} onChange={e => setTo(e.target.value)} style={sel} /></FilterField>
            <div style={{ gridColumn: "1/-1" }}><FilterField label="Vendor"><input value={vend} onChange={e => setVend(e.target.value)} placeholder="Search…" style={sel} /></FilterField></div>
            <FilterField label="Status"><select value={stat} onChange={e => setStat(e.target.value)} style={sel}><option value="all">All</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></FilterField>
            <FilterField label="Type"><select value={type} onChange={e => setType(e.target.value)} style={sel}><option value="all">All</option><option value="invoice">Invoices</option><option value="credit_note">Credit Notes</option></select></FilterField>
            <FilterField label="Min amount"><input type="number" value={minA} onChange={e => setMinA(e.target.value)} style={sel} /></FilterField>
            <FilterField label="Max amount"><input type="number" value={maxA} onChange={e => setMaxA(e.target.value)} style={sel} /></FilterField>
          </div>
        </div>

        <div className="report-tabs" style={{ display: "flex", gap: 4, backgroundColor: "#fff", borderRadius: 14, padding: 4, border: "1px solid #f3f4f6", marginBottom: 16 }}>
          {TABS.map(t => <button key={t.key} onClick={() => setTab(t.key)} style={{ flex: 1, padding: "9px 8px", borderRadius: 10, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13, backgroundColor: tab === t.key ? NAVY : "transparent", color: tab === t.key ? "#fff" : "#9ca3af" }}>{t.label}</button>)}
        </div>
      </div>

      {/* SPEND */}
      {tab === "spend" && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 16 }}>
          {[["Docs", rows.length, v => v], ["Total", total, R], ["VAT", totalVat, R], ["Excl. VAT", excl, R]].map(([l, v, f]) => (
            <div key={l} style={{ backgroundColor: "#fff", borderRadius: 14, padding: 14, border: "1px solid #f3f4f6" }}>
              <p style={{ color: "#9ca3af", fontSize: 11, margin: "0 0 4px", fontWeight: 600 }}>{l}</p>
              <p style={{ color: NAVY, fontSize: 18, fontWeight: 900, margin: 0 }}>{f(v)}</p>
            </div>
          ))}
        </div>
        <div style={{ backgroundColor: "#fff", borderRadius: 16, padding: 16, border: "1px solid #f3f4f6" }}>
          <p style={{ fontWeight: 800, color: NAVY, fontSize: 14, margin: "0 0 12px" }}>By status</p>
          {Object.entries(STATUS_META).map(([k]) => {
            const n = rows.filter(d => d.status === k).length; if (!n) return null;
            return <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f9fafb" }}><Badge status={k} /><span style={{ fontWeight: 700, color: "#374151" }}>{n}</span></div>;
          })}
        </div>
        <div style={{ backgroundColor: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", overflowX: "auto", marginTop: 16 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e5e7eb", backgroundColor: "#f8fafc" }}>
                {["Vendor", "Document", "Date", "Status", "Amount"].map(h => (
                  <th key={h} style={{ padding: "10px 12px", textAlign: h === "Amount" ? "right" : "left", color: "#64748b", fontSize: 12, fontWeight: 700 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan="5" style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>No documents match the current filters.</td></tr>
                : rows.slice(0, 8).map(d => (
                    <tr key={d.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "10px 12px", fontWeight: 700, color: NAVY }}>{d.extracted?.vendor_name || "-"}</td>
                      <td style={{ padding: "10px 12px", color: "#475569" }}>{d.extracted?.invoice_number || d.fileName || "-"}</td>
                      <td style={{ padding: "10px 12px", color: "#475569" }}>{d.extracted?.invoice_date || d.uploadDate.slice(0, 10)}</td>
                      <td style={{ padding: "10px 12px" }}><Badge status={d.status} /></td>
                      <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 800, color: NAVY }}>{R(d.extracted?.total_amount)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </>}

      {/* VENDOR */}
      {tab === "vendor" && <div style={{ backgroundColor: "#fff", borderRadius: 16, padding: 16, border: "1px solid #f3f4f6" }}>
        <p style={{ fontWeight: 800, color: NAVY, fontSize: 14, margin: "0 0 16px" }}>Spend by vendor</p>
        {Object.keys(byVendor).length === 0
          ? <p style={{ color: "#9ca3af", textAlign: "center", padding: 24 }}>No records match the selected filters.</p>
          : Object.entries(byVendor).sort((a, b) => b[1] - a[1]).map(([v, amt]) => {
              const pct = total > 0 ? (amt / total) * 100 : 0;
              return <div key={v} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, color: "#374151" }}>{v}</span>
                  <span style={{ fontWeight: 700, color: NAVY }}>{R(amt)} <span style={{ color: "#9ca3af", fontWeight: 400 }}>({pct.toFixed(1)}%)</span></span>
                </div>
                <div style={{ backgroundColor: "#f3f4f6", borderRadius: 99, height: 8 }}><div style={{ backgroundColor: GOLD, borderRadius: 99, height: 8, width: pct + "%" }} /></div>
              </div>;
            })
        }
      </div>}

      {/* VAT */}
      {tab === "vat" && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
          {[["Incl. VAT", total], ["VAT", totalVat], ["Excl.", excl]].map(([l, v]) => (
            <div key={l} style={{ backgroundColor: "#fff", borderRadius: 14, padding: 14, border: "1px solid #f3f4f6" }}>
              <p style={{ color: "#9ca3af", fontSize: 11, margin: "0 0 4px", fontWeight: 600 }}>{l}</p>
              <p style={{ color: NAVY, fontSize: 15, fontWeight: 900, margin: 0 }}>{R(v)}</p>
            </div>
          ))}
        </div>
        <div style={{ backgroundColor: "#fff", borderRadius: 16, border: "1px solid #f3f4f6", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ borderBottom: "2px solid #f3f4f6" }}>{["Vendor", "Inv #", "Date", "Excl", "VAT", "Total"].map(h => <th key={h} style={{ padding: "10px 12px", textAlign: "left", color: "#9ca3af", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan="6" style={{ padding: 24, textAlign: "center", color: "#9ca3af" }}>No records match the selected filters.</td></tr>
                : rows.map(d => { const t = Number(d.extracted?.total_amount) || 0, v = Number(d.extracted?.vat_amount) || 0;
                    return <tr key={d.id} style={{ borderBottom: "1px solid #f9fafb" }}>
                      <td style={{ padding: "10px 12px", fontWeight: 600 }}>{d.extracted?.vendor_name || "—"}</td>
                      <td style={{ padding: "10px 12px", color: "#6b7280" }}>{d.extracted?.invoice_number || "—"}</td>
                      <td style={{ padding: "10px 12px", color: "#6b7280" }}>{d.extracted?.invoice_date || "—"}</td>
                      <td style={{ padding: "10px 12px" }}>{R(t - v)}</td>
                      <td style={{ padding: "10px 12px" }}>{R(v)}</td>
                      <td style={{ padding: "10px 12px", fontWeight: 700 }}>{R(t)}</td>
                    </tr>;
                  })}
            </tbody>
          </table>
        </div>
      </>}

      {/* LIST */}
      {tab === "list" && <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.length === 0 ? <p style={{ textAlign: "center", color: "#9ca3af", padding: 32 }}>No records match the selected filters.</p>
          : rows.map(d => (
              <div key={d.id} style={{ backgroundColor: "#fff", borderRadius: 14, padding: 14, border: "1px solid #f3f4f6", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontWeight: 700, fontSize: 14, color: NAVY, margin: 0 }}>{d.extracted?.vendor_name || "—"}{d.isDup && <span style={{ color: "#f97316", marginLeft: 4 }}>⚠</span>}</p>
                  <p style={{ color: "#9ca3af", fontSize: 12, margin: "2px 0" }}>{d.type === "invoice" ? "Invoice" : "Credit Note"} · #{d.extracted?.invoice_number || "—"} · {d.extracted?.invoice_date || "—"}</p>
                  <p style={{ color: NAVY, fontWeight: 700, fontSize: 14, margin: "4px 0" }}>{R(d.extracted?.total_amount)}</p>
                  <Badge status={d.status} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                  <p style={{ color: "#d1d5db", fontSize: 11, margin: 0 }}>{d.uploadDate.slice(0, 10)}</p>
                  {user?.role === "admin" && <button onClick={() => del(d.id)} disabled={delId === d.id} style={{ fontSize: 11, color: "#ef4444", background: "none", border: "none", cursor: "pointer", fontWeight: 600, padding: 0 }}>{delId === d.id ? "…" : "Delete"}</button>}
                </div>
              </div>
            ))}
      </div>}
    </div>
  );
}

/* ================================================================
   INSIGHTS
================================================================ */
function Insights({ docs }) {
  const [insights, setInsights] = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  async function generate() {
    setLoading(true); setError("");
    try { setInsights(await aiInsights(docs)); }
    catch (e) { setError("Insights could not be generated. Please try again."); }
    finally { setLoading(false); }
  }

  return (
    <div className="page-shell page-enter insights-page">
      <div className="page-header">
        <h2>Spend Insights</h2>
        <p>Insights are based on the submitted document records.</p>
      </div>
      <h2 style={{ display: "none" }}>Spend Insights</h2>
      <p style={{ color: "#9ca3af", fontSize: 13, margin: "0 0 20px" }}>Spending trends, anomalies & patterns · {docs.length} document{docs.length !== 1 ? "s" : ""}</p>

      {docs.length === 0
        ? <div style={{ backgroundColor: "#fff", borderRadius: 10, padding: 32, textAlign: "center", border: "1px solid #e5e7eb" }}><p style={{ color: "#64748b", fontSize: 14, margin: 0 }}>No submitted documents are available for insights yet.</p></div>
        : <>
            <div className="insight-toolbar">
              <span>{docs.length} submitted document{docs.length !== 1 ? "s" : ""}</span>
              <span>Submitted records</span>
            </div>
            <button className="primary-action" onClick={generate} disabled={loading}
              style={{ padding: "10px 16px", borderRadius: 8, border: "none", backgroundColor: NAVY, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: loading ? 0.7 : 1, marginBottom: 16, width: "auto" }}>
              {loading ? "Generating insights..." : insights ? "Regenerate Insights" : "Generate Insights"}
            </button>
            {error && <div style={{ backgroundColor: "#fee2e2", borderRadius: 12, padding: "12px 16px", color: "#dc2626", fontSize: 14, marginBottom: 16 }}>{error}</div>}
            {loading && [1, 2, 3, 4, 5].map(i => (
              <div key={i} style={{ backgroundColor: "#fff", borderRadius: 16, padding: 16, marginBottom: 10, border: "1px solid #f3f4f6", display: "flex", gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: "#f3f4f6", flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ height: 12, backgroundColor: "#f3f4f6", borderRadius: 6, marginBottom: 6, width: "75%" }} />
                  <div style={{ height: 12, backgroundColor: "#f3f4f6", borderRadius: 6, width: "50%" }} />
                </div>
              </div>
            ))}
            {insights && !loading && insights.map((text, i) => (
              <div key={i} className="insight-card" style={{ backgroundColor: "#fff", borderRadius: 10, padding: 16, marginBottom: 10, border: "1px solid #e5e7eb" }}>
                <div>
                  <span className="insight-category">{insightCategory(text, i)}</span>
                  <p style={{ color: "#374151", fontSize: 14, margin: 0, lineHeight: 1.6, paddingTop: 8 }}>{text}</p>
                </div>
              </div>
            ))}
          </>
      }
    </div>
  );
}

/* ================================================================
   APP ROOT
================================================================ */
export default function App() {
  const [user,      setUser]      = useState(null);
  const [view,      setView]      = useState("upload");
  const [docs,      setDocs]      = useState([]);
  const [loginErr,  setLoginErr]  = useState("");
  const [loginLoad, setLoginLoad] = useState(false);

  useEffect(() => {
    async function fetchDocsFromServer() {
      const token = localStorage.getItem("token");
      if (!token) { setDocs(getDocs()); return; }
      const restored = userFromToken(token);
      if (!restored) {
        localStorage.removeItem("token");
        setDocs(getDocs());
        return;
      }
      setLoginLoad(true);
      setUser(restored);
      setView(defaultViewForUser(restored));
      try {
        const j = await fetchServerDocs(token);
        setStore(j); setDocs(j);
      } catch (e) {
        localStorage.removeItem("token");
        setUser(null);
        setDocs(getDocs());
      } finally {
        setLoginLoad(false);
      }
    }
    fetchDocsFromServer();
  }, []);

  useEffect(() => {
    if (user && !canAccessView(user, view)) setView(defaultViewForUser(user));
  }, [user, view]);

  async function login(u, p) {
    setLoginLoad(true); setLoginErr("");
    try {
      const res = await fetch(apiUrl("/api/login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: (u||"").trim().toLowerCase(), password: p }) });
      const j = await readApiJson(res, "Invalid username or password.");
      const serverDocs = await fetchServerDocs(j.token);
      localStorage.setItem("token", j.token);
      setStore(serverDocs); setDocs(serverDocs);
      setUser(j.user); setView(defaultViewForUser(j.user));
    } catch (e) { setLoginErr(e.message || "Unable to sign in. Please check your credentials and try again."); }
    finally { setLoginLoad(false); }
  }

  function logout() {
    localStorage.removeItem("token");
    setUser(null);
    setDocs(getDocs());
  }

  if (!user) return <Login onLogin={login} error={loginErr} loading={loginLoad} />;

  return (
    <>
      <style>{`
        :root {
          --midnight: #071832;
          --navy: #0B1E3D;
          --navy-2: #12345f;
          --gold: #C9A227;
          --gold-soft: #fff3c4;
          --paper: #fffdf8;
          --surface: rgba(255,255,255,0.92);
          --ink: #10223f;
          --muted: #64748b;
          --line: rgba(15, 23, 42, 0.08);
          --shadow-sm: 0 8px 24px rgba(11,30,61,0.08);
          --shadow-md: 0 18px 48px rgba(11,30,61,0.13);
          --shadow-lg: 0 28px 70px rgba(0,0,0,0.28);
          --radius: 18px;
        }
        *, *::before, *::after { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: Aptos, 'Segoe UI', Tahoma, sans-serif;
          color: var(--ink);
          background:
            radial-gradient(circle at 12% 4%, rgba(201,162,39,0.13), transparent 26%),
            radial-gradient(circle at 86% 12%, rgba(18,52,95,0.14), transparent 30%),
            linear-gradient(135deg, #f7f5ef 0%, #eef3f8 48%, #f9fafb 100%);
        }
        button, input, select { font: inherit; }
        button { transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease, background .18s ease; }
        button:hover:not(:disabled) { transform: translateY(-1px); }
        button:focus-visible, input:focus-visible, select:focus-visible {
          outline: 3px solid rgba(201,162,39,0.35) !important;
          outline-offset: 2px;
        }
        .login-stage {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 28px;
          overflow: hidden;
          position: relative;
          background:
            linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px),
            radial-gradient(circle at 18% 22%, rgba(201,162,39,0.25), transparent 28%),
            radial-gradient(circle at 78% 12%, rgba(76,133,196,0.24), transparent 26%),
            linear-gradient(145deg, #061326 0%, #0b1e3d 54%, #142f54 100%);
          background-size: 44px 44px, 44px 44px, auto, auto, auto;
        }
        .login-stage::after {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-image: linear-gradient(120deg, rgba(255,255,255,0.08), transparent 30%, rgba(201,162,39,0.08));
          opacity: .45;
          animation: ambientShift 12s ease-in-out infinite alternate;
        }
        .login-grid {
          width: min(1020px, 100%);
          display: grid;
          grid-template-columns: minmax(0, 1.1fr) minmax(340px, .9fr);
          gap: 28px;
          position: relative;
          z-index: 1;
          align-items: center;
        }
        .login-hero { color: #fff; padding: 22px; }
        .brand-lockup { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; }
        .brand-mark {
          width: 64px;
          height: 64px;
          border-radius: 18px;
          display: grid;
          place-items: center;
          background: linear-gradient(145deg, #f4d66b, var(--gold));
          color: var(--midnight);
          font-size: 30px;
          font-weight: 950;
          box-shadow: 0 20px 50px rgba(201,162,39,0.25);
        }
        .brand-lockup h1 { margin: 0; font-size: 34px; letter-spacing: -0.02em; }
        .brand-lockup h1 span, .eyebrow { color: var(--gold); }
        .brand-lockup p, .login-kicker { color: rgba(255,255,255,0.68); margin: 4px 0 0; }
        .login-kicker { font-size: 18px; line-height: 1.6; max-width: 560px; }
        .login-proof-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
        .proof-pill, .method-badge, .confidence-pill, .insight-category {
          border: 1px solid rgba(201,162,39,0.28);
          background: rgba(201,162,39,0.12);
          color: #735a10;
          border-radius: 999px;
          padding: 7px 10px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: .04em;
          text-transform: uppercase;
        }
        .login-stage .proof-pill { color: #ffe9a6; border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.08); }
        .glass-panel {
          background: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,253,248,0.84));
          border: 1px solid rgba(255,255,255,0.55);
          box-shadow: var(--shadow-lg);
          backdrop-filter: blur(18px);
        }
        .login-card { border-radius: 28px; padding: 28px; }
        .form-heading { margin-bottom: 20px; }
        .eyebrow { margin: 0 0 6px; font-size: 11px; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
        .form-heading h2, .page-header h2 { margin: 0; color: var(--ink); letter-spacing: -0.03em; }
        .form-row { margin-bottom: 15px; }
        .form-row label { display: block; color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .09em; margin-bottom: 7px; }
        .form-row input, .form-row select, .filter-panel input, .filter-panel select, .extraction-console input, .extraction-console select {
          width: 100%;
          border: 1px solid rgba(15,23,42,0.12) !important;
          background: rgba(255,255,255,0.82) !important;
          border-radius: 13px !important;
          padding: 12px 14px !important;
          color: var(--ink);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.5);
        }
        .alert-error { color: #b91c1c; background: #fee2e2; border: 1px solid #fecaca; padding: 10px 12px; border-radius: 12px; font-size: 13px; }
        .primary-action {
          background: linear-gradient(135deg, var(--navy), var(--navy-2)) !important;
          color: #fff !important;
          border: none !important;
          box-shadow: 0 16px 34px rgba(11,30,61,0.22), inset 0 1px 0 rgba(255,255,255,0.18) !important;
          position: relative;
          overflow: hidden;
        }
        .primary-action:hover:not(:disabled) { box-shadow: 0 20px 42px rgba(11,30,61,0.28) !important; }
        .primary-action:disabled { background: #e5e7eb !important; box-shadow: none !important; color: #94a3b8 !important; }
        .demo-account-panel { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
        .demo-account-panel > p { margin: 0 0 10px; color: var(--muted); font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .12em; }
        .demo-account-list { display: grid; gap: 8px; }
        .demo-account {
          width: 100%;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          border: 1px solid rgba(15,23,42,0.08);
          background: #fff;
          border-radius: 14px;
          padding: 10px 12px;
          cursor: pointer;
          text-align: left;
        }
        .demo-account b { display: block; color: var(--ink); }
        .demo-account small { color: var(--muted); }
        .demo-account em { color: #7c6519; font-style: normal; font-size: 11px; font-weight: 800; }
        .app-shell { background: transparent; }
        .main-stage {
          min-width: 0;
          padding: 28px 22px 104px !important;
          background:
            radial-gradient(circle at 8% 0%, rgba(201,162,39,0.12), transparent 26%),
            radial-gradient(circle at 90% 8%, rgba(11,30,61,0.08), transparent 28%);
        }
        .mobile-nav { display: flex !important; background: rgba(255,255,255,0.92) !important; backdrop-filter: blur(16px); }
        .desktop-nav {
          display: none !important;
          background: linear-gradient(180deg, #061326, var(--navy) 62%, #102b50) !important;
          box-shadow: 18px 0 50px rgba(5,18,38,0.18);
          position: sticky;
          top: 0;
        }
        .desktop-nav button { border-radius: 14px !important; }
        .page-shell { max-width: 1180px; margin: 0 auto; }
        .page-enter { animation: pageIn .34s ease both; }
        .page-header {
          margin: 4px 0 22px;
          padding: 2px 2px 0;
        }
        .page-header.compact { margin-bottom: 0; }
        .page-header h2 { font-size: 28px; font-weight: 950; }
        .page-header p:last-child { color: var(--muted); margin: 6px 0 0; font-size: 14px; line-height: 1.5; max-width: 680px; }
        .page-header + h2 + p { display: none !important; }
        .premium-card, .workflow-card, .insight-card, .stats-grid > div {
          background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(255,253,248,0.93)) !important;
          border: 1px solid rgba(15,23,42,0.08) !important;
          box-shadow: var(--shadow-sm) !important;
          position: relative;
          overflow: hidden;
        }
        .premium-card:hover, .workflow-card:hover, .insight-card:hover, .stats-grid > div:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-md) !important;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 14px;
          margin-bottom: 24px;
        }
        .stats-grid > div {
          border-radius: 18px !important;
          padding: 16px !important;
          position: relative;
          overflow: hidden;
        }
        .stats-grid > div::after, .premium-card::after {
          content: "";
          position: absolute;
          inset: auto 14px 0 14px;
          height: 3px;
          border-radius: 99px 99px 0 0;
          background: linear-gradient(90deg, var(--gold), rgba(11,30,61,0.2));
          opacity: .55;
        }
        .metric-icon {
          width: 42px;
          height: 42px;
          border-radius: 13px;
          display: grid;
          place-items: center;
          font-weight: 950;
          flex-shrink: 0;
        }
        .metric-copy p { color: var(--muted); font-size: 11px; margin: 0; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
        .metric-copy strong { display: block; font-size: 27px; line-height: 1; margin-top: 3px; }
        .metric-copy small { color: #94a3b8; font-size: 11px; }
        .intake-console, .filter-panel { position: relative; overflow: hidden; }
        .upload-dropzone {
          background:
            linear-gradient(135deg, rgba(255,255,255,0.88), rgba(255,248,222,0.65)),
            repeating-linear-gradient(135deg, rgba(201,162,39,0.08) 0 1px, transparent 1px 12px) !important;
          border-color: rgba(201,162,39,0.44) !important;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.6);
        }
        .upload-dropzone:hover, .upload-dropzone.is-dragging { transform: translateY(-1px); box-shadow: var(--shadow-sm); }
        .demo-strip { background: linear-gradient(135deg, #fff8dd, #fffdf7) !important; border-color: rgba(201,162,39,0.32) !important; }
        .extraction-meta { background: linear-gradient(135deg, #f8fafc, #fffdf8) !important; }
        .meta-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
        .confidence-pill { color: var(--navy); background: rgba(18,52,95,0.08); border-color: rgba(18,52,95,0.14); }
        .submit-action { border-radius: 15px !important; }
        .workflow-card { border-radius: 20px !important; }
        .workflow-card input { border-radius: 13px !important; }
        .filter-panel { border-radius: 20px !important; }
        .report-tabs { border-radius: 16px !important; box-shadow: var(--shadow-sm); }
        .report-tabs button { border-radius: 12px !important; }
        table th { letter-spacing: .08em; }
        tbody tr { transition: background .18s ease; }
        tbody tr:hover { background: rgba(201,162,39,0.06); }
        .insight-toolbar {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
          margin-bottom: 12px;
        }
        .insight-toolbar span {
          color: var(--muted);
          background: rgba(255,255,255,0.72);
          border: 1px solid var(--line);
          border-radius: 999px;
          padding: 7px 10px;
          font-size: 12px;
          font-weight: 800;
        }
        .insight-card { border-radius: 20px !important; }
        .insight-icon {
          width: 44px;
          height: 44px;
          border-radius: 14px;
          display: grid;
          place-items: center;
          background: linear-gradient(145deg, rgba(201,162,39,0.24), rgba(18,52,95,0.08));
          color: var(--navy);
          font-size: 13px;
          font-weight: 950;
          flex-shrink: 0;
        }
        .insight-category { display: inline-flex; margin-bottom: 2px; }
        .empty-state { border-radius: 22px !important; color: var(--muted); }
        [style*="backgroundColor: \\"#f3f4f6\\""] {
          background-size: 200% 100%;
        }
        body {
          background: #f4f6f8;
        }
        button:hover:not(:disabled) {
          transform: none;
        }
        .main-stage {
          background: #f4f6f8 !important;
          padding: 24px 22px 80px !important;
        }
        .desktop-nav {
          background: #071832 !important;
          box-shadow: none;
        }
        .desktop-nav button {
          border-radius: 8px !important;
        }
        .page-shell {
          max-width: 1120px;
        }
        .page-header {
          margin: 0 0 18px;
        }
        .page-header .eyebrow {
          display: none !important;
        }
        .page-header h2 {
          font-size: 25px;
          font-weight: 800;
          letter-spacing: -0.02em;
        }
        .page-header p:last-child {
          font-size: 14px;
          color: #64748b;
        }
        .primary-action {
          background: var(--navy) !important;
          box-shadow: none !important;
          border-radius: 8px !important;
        }
        .premium-card, .workflow-card, .insight-card, .stats-grid > div {
          background: #fff !important;
          border: 1px solid #e5e7eb !important;
          box-shadow: 0 1px 2px rgba(15,23,42,0.04) !important;
          border-radius: 10px !important;
        }
        .premium-card:hover, .workflow-card:hover, .insight-card:hover, .stats-grid > div:hover {
          transform: none;
          box-shadow: 0 1px 2px rgba(15,23,42,0.04) !important;
        }
        .stats-grid {
          gap: 10px;
          margin-bottom: 20px;
        }
        .stats-grid > div {
          padding: 12px 14px !important;
        }
        .stats-grid > div::after, .premium-card::after {
          display: none;
        }
        .upload-dropzone {
          background: #fff !important;
          border-color: #cbd5e1 !important;
          border-radius: 10px !important;
          box-shadow: none !important;
          padding: 24px !important;
        }
        .demo-strip {
          background: #f8fafc !important;
          border-color: #e5e7eb !important;
        }
        .extraction-meta {
          background: #f8fafc !important;
        }
        .method-badge, .confidence-pill, .insight-category {
          border-color: #dbe3ee;
          background: #f8fafc;
          color: #475569;
          text-transform: none;
          letter-spacing: 0;
          font-weight: 700;
        }
        .workflow-card {
          border-radius: 10px !important;
        }
        .filter-panel {
          border-radius: 10px !important;
        }
        .report-tabs {
          box-shadow: none;
          border-color: #e5e7eb !important;
          border-radius: 10px !important;
        }
        .report-tabs button {
          border-radius: 7px !important;
        }
        .insight-card {
          border-radius: 10px !important;
        }
        .insight-card .insight-category {
          display: block;
          width: fit-content;
          border: 0;
          background: transparent;
          padding: 0;
          color: #64748b;
          font-size: 12px;
          font-weight: 800;
          margin-bottom: 8px;
        }
        .insight-toolbar span {
          background: #fff;
          border-color: #e5e7eb;
          border-radius: 8px;
          font-size: 12px;
        }
        @keyframes pageIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes ambientShift { from { transform: translate3d(-1%, -1%, 0); } to { transform: translate3d(1%, 1%, 0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (min-width: 768px) {
          .mobile-nav  { display: none !important; }
          .desktop-nav { display: flex !important; }
        }
        @media (max-width: 960px) {
          .login-grid { grid-template-columns: 1fr; }
          .login-hero { text-align: center; padding: 0; }
          .brand-lockup { justify-content: center; }
          .login-proof-grid { justify-content: center; }
          .stats-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
        }
        @media (max-width: 640px) {
          .login-stage { padding: 18px; }
          .brand-lockup { align-items: flex-start; text-align: left; }
          .brand-lockup h1 { font-size: 28px; }
          .login-card { padding: 20px; border-radius: 22px; }
          .main-stage { padding: 18px 14px 96px !important; }
          .page-header h2 { font-size: 24px; }
          .stats-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
        }
      `}</style>
      <div className="app-shell" style={{ display: "flex", minHeight: "100vh" }}>
        <Nav user={user} view={view} setView={setView} onLogout={logout} docs={docs} />
        <main className="main-stage" style={{ flex: 1, padding: "20px 16px 100px", overflowX: "hidden" }}>
          <Stats docs={docs} />
          {view === "upload"    && <Upload    user={user} docs={docs} onUpdate={setDocs} />}
          {view === "approvals" && <Approvals user={user} docs={docs} onUpdate={setDocs} />}
          {view === "reports"   && <Reports   user={user} docs={docs} onUpdate={setDocs} />}
          {view === "insights"  && <Insights  docs={docs} />}
        </main>
      </div>
    </>
  );
}
