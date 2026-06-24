const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./lib/db");
const { requestOpenRouterJson, safeDevLog } = require("./lib/openrouter");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "docflow-dev-secret";

const ALLOWED_DOC_TYPES = new Set(["invoice", "credit_note"]);
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png"]);
const ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const AI_PROVIDER_TIMEOUT_MS = Number(process.env.AI_PROVIDER_TIMEOUT_MS || 18000);
const INVOICE_KEYWORD_RE = /\b(supplier|vendor|invoice|credit\s*note|vat|tax|total|amount|date|bill\s*from|balance)\b/i;

const allowedOrigins = [
  process.env.FRONTEND_URL,
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) return cb(null, true);
    cb(new Error("CORS: origin not allowed - " + origin));
  },
}));

app.use(express.json({ limit: "25mb" }));

function signToken(user) {
  return jwt.sign({
    id: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    approvalStep: user.approvalStep || null,
    stepLabel: user.stepLabel || null,
  }, JWT_SECRET, { expiresIn: "8h" });
}

async function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return res.status(401).json({ error: "Missing Authorization" });
  try {
    const user = jwt.verify(h.slice(7), JWT_SECRET);
    if (!user.id && user.username) {
      const fresh = await db.getUserByUsername(user.username);
      if (fresh) user.id = fresh.id;
    }
    req.user = user;
    return next();
  } catch (e) {
    return res.status(401).json({ error: e.message || "Invalid token" });
  }
}

function canUpload(user) {
  return user.role === "admin";
}

function isFinanceApprover(user) {
  return user.role === "approver" && Number(user.approvalStep || 0) === 3;
}

function canViewReports(user) {
  return user.role === "admin" || user.role === "viewer" || isFinanceApprover(user);
}

function canViewInsights(user) {
  return canViewReports(user);
}

function visibleDocumentsForUser(user, docs = []) {
  if (user.role === "admin" || user.role === "viewer" || isFinanceApprover(user)) return docs;
  if (user.role === "approver") {
    const step = Number(user.approvalStep || 0);
    return docs.filter((doc) => doc.status === `pending_approval_${step}`);
  }
  return [];
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDocType(value) {
  const v = normalizeText(value).replace(/\s+/g, "_").replace(/-/g, "_");
  if (["credit_note", "credit", "creditnote", "cn"].includes(v)) return "credit_note";
  if (["invoice", "inv"].includes(v)) return "invoice";
  return null;
}

function validateDocumentType(value) {
  const type = normalizeDocType(value);
  if (!type || !ALLOWED_DOC_TYPES.has(type)) return null;
  return type;
}

function validateUploadFile({ fileName = "", mimeType = "" }) {
  const ext = path.extname(fileName).toLowerCase();
  if (mimeType && !ALLOWED_MIME_TYPES.has(mimeType)) return "Only PDF, JPG, JPEG, and PNG files are accepted";
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) return "Only PDF, JPG, JPEG, and PNG files are accepted";
  if (!mimeType && !ext) return "A supported file type is required";
  return null;
}

function stripPdfNoise(raw) {
  return raw
    .replace(/\\([nrtbf()\\])/g, " ")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasUsefulInvoiceText(text = "") {
  const clean = String(text || "").trim();
  return clean.length >= 20 && INVOICE_KEYWORD_RE.test(clean);
}

function extractTextFromUpload(dataBase64 = "", mimeType = "") {
  if (!dataBase64 || typeof dataBase64 !== "string") return "";
  const buffer = Buffer.from(dataBase64, "base64");
  if (!buffer.length) return "";

  if (mimeType === "application/pdf") {
    const raw = buffer.toString("latin1");
    const literalStrings = [...raw.matchAll(/\(([^()]|\\.){3,}\)/g)]
      .map((m) => m[0].slice(1, -1))
      .join(" ");
    const hexStrings = [...raw.matchAll(/<([0-9a-fA-F\s]{8,})>/g)]
      .map((m) => {
        try {
          return Buffer.from(m[1].replace(/\s+/g, ""), "hex").toString("utf8");
        } catch {
          return "";
        }
      })
      .join(" ");
    const extracted = stripPdfNoise(`${literalStrings} ${hexStrings} ${raw.slice(0, 120000)}`);
    return hasUsefulInvoiceText(extracted) ? extracted : "";
  }

  if (mimeType && mimeType.startsWith("image/")) return "";
  return stripPdfNoise(buffer.toString("utf8"));
}

function toIsoDate(value = "") {
  const raw = String(value).trim();
  if (!raw) return "";
  const iso = raw.match(/\b(20\d{2}|19\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;

  const dmy = raw.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2}|19\d{2})\b/);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;

  const months = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
  const named = raw.match(new RegExp(`\\b(0?[1-9]|[12]\\d|3[01])\\s+(${months})[a-z]*\\s+(20\\d{2}|19\\d{2})\\b`, "i"));
  if (named) {
    const key = named[2].toLowerCase().startsWith("sep") ? "sep" : named[2].toLowerCase().slice(0, 3);
    const idx = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[key];
    return `${named[3]}-${String(idx).padStart(2, "0")}-${String(named[1]).padStart(2, "0")}`;
  }
  return "";
}

function parseMoney(value = "") {
  const raw = String(value).replace(/zar|r|vat|total|amount|incl|exclusive|inclusive|:/gi, "").trim();
  const match = raw.match(/-?\d[\d\s,]*(?:\.\d{1,2})?/);
  if (!match) return null;
  const n = Number(match[0].replace(/[\s,]/g, ""));
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function isValidIsoDate(value = "") {
  const iso = toIsoDate(value);
  if (!iso) return false;
  const [year, month, day] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return (match[1] || match[0] || "").trim();
  }
  return "";
}

function cleanVendorValue(value = "") {
  return String(value || "")
    .replace(/^[\s:#-]+/, "")
    .replace(/^(?:vat|tax|invoice|customer|buyer|merchant|seller|supplier|vendor|address|total|sub[-\s]?total|business\s+name)\b.*$/i, "")
    .replace(/\s+(?:vat|tax|invoice|customer|buyer|merchant|seller|supplier|vendor|address|total|sub[-\s]?total|business\s+name)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRealVendorValue(value = "") {
  if (/^\s*[-:#]*\s*(?:-|n\/?a)?\s*$/i.test(String(value || ""))) return false;
  const clean = cleanVendorValue(value);
  return Boolean(clean && clean !== "-" && !/^n\/?a$/i.test(clean) && !/^(supplier|vendor|merchant|seller|customer|buyer|address)$/i.test(clean) && /[A-Za-z0-9]/.test(clean));
}

function labelValueFromLine(line = "", labelPattern) {
  const match = String(line || "").match(labelPattern);
  if (!match) return "";
  return cleanVendorValue(match[1] || "");
}

function extractBusinessNameVendor(lines = []) {
  const candidates = [];

  lines.forEach((line, index) => {
    const sameLineValue = labelValueFromLine(line, /\bbusiness\s+name\b\s*[:#-]?\s*(.+)$/i);
    const nextLineValue = /\bbusiness\s+name\b\s*[:#-]?\s*$/i.test(line) ? cleanVendorValue(lines[index + 1] || "") : "";
    const value = isRealVendorValue(sameLineValue) ? sameLineValue : nextLineValue;
    if (!isRealVendorValue(value)) return;

    const context = lines.slice(Math.max(0, index - 5), Math.min(lines.length, index + 6)).join(" ");
    const customerContext = /\b(customer|buyer|bill\s*to|ship\s*to|delivery\s+to|invoice\s+to|sold\s+to)\b/i.test(context);
    const supplierContext = /\b(supplier|vendor|merchant|seller|issued\s+on\s+behalf|registered\s+address|supplier\s+address|vat\s*(?:number|no|registration)?)\b/i.test(context);
    const earlyDocument = index <= Math.ceil(lines.length * 0.45);
    const score = (supplierContext ? 20 : 0) + (earlyDocument ? 5 : 0) - (customerContext ? 30 : 0);
    candidates.push({ value, index, score, customerContext });
  });

  const preferred = candidates
    .filter((candidate) => !candidate.customerContext)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0];
  if (preferred) return preferred.value;

  return candidates.sort((a, b) => b.score - a.score || a.index - b.index)[0]?.value || "";
}

function compactLabelValue(compact = "", label = "") {
  const escaped = label.replace(/\s+/g, "\\s+");
  const stopWords = [
    "business\\s+name",
    "customer\\s+(?:information|info)",
    "supplier\\s+(?:address|information|info)",
    "merchant\\b",
    "seller\\b",
    "vendor\\b",
    "vat\\b",
    "tax\\b",
    "invoice\\b",
    "total\\b",
    "sub[-\\s]?total\\b",
    "amount\\b",
    "date\\b",
    "address\\b",
  ].join("|");
  const match = compact.match(new RegExp(`\\b${escaped}\\b\\s*[:#-]?\\s*(.+?)(?=\\s+(?:${stopWords})|$)`, "i"));
  return match ? cleanVendorValue(match[1]) : "";
}

function extractCompactBusinessNameVendor(compact = "") {
  const re = /\bbusiness\s+name\b/gi;
  const candidates = [];
  let match;

  while ((match = re.exec(compact))) {
    const after = compact.slice(match.index + match[0].length);
    const raw = after.match(/^\s*[:#-]?\s*(.+?)(?=\s+(?:business\s+name|customer\s+(?:information|info)|supplier\s+(?:address|information|info)|merchant\b|seller\b|vendor\b|vat\b|tax\b|invoice\b|total\b|sub[-\s]?total\b|amount\b|date\b|address\b)|$)/i)?.[1] || "";
    const value = cleanVendorValue(raw);
    if (!isRealVendorValue(value)) continue;

    const context = compact.slice(Math.max(0, match.index - 160), Math.min(compact.length, match.index + 220));
    const customerContext = /\b(customer|buyer|bill\s*to|ship\s*to|delivery\s+to|invoice\s+to|sold\s+to)\b/i.test(context);
    const supplierContext = /\b(supplier|vendor|merchant|seller|issued\s+on\s+behalf|registered\s+address|supplier\s+address|vat\s*(?:number|no|registration)?)\b/i.test(context);
    const earlyDocument = match.index <= compact.length * 0.45;
    const score = (supplierContext ? 20 : 0) + (earlyDocument ? 5 : 0) - (customerContext ? 30 : 0);
    candidates.push({ value, index: match.index, score, customerContext });
  }

  return candidates
    .filter((candidate) => !candidate.customerContext)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.value ||
    candidates.sort((a, b) => b.score - a.score || a.index - b.index)[0]?.value ||
    "";
}

function extractVendorFromText(clean = "", compact = "") {
  const lines = clean.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const businessName = extractBusinessNameVendor(lines) || extractCompactBusinessNameVendor(compact);
  if (businessName) return businessName;

  const behalfVendor = firstMatch(compact, [
    /invoice\s+is\s+issued\s+on\s+behalf\s+of\s+([A-Za-z0-9 &().,'/-]{3,80}?)(?=\s+(?:invoice|date|vat|tax|total|amount|customer|business\s+name)\b|$)/i,
    /issued\s+on\s+behalf\s+of\s+([A-Za-z0-9 &().,'/-]{3,80}?)(?=\s+(?:invoice|date|vat|tax|total|amount|customer|business\s+name)\b|$)/i,
  ]);
  if (isRealVendorValue(behalfVendor)) return cleanVendorValue(behalfVendor);

  for (const label of ["supplier", "vendor", "merchant", "seller"]) {
    const value = compactLabelValue(compact, label);
    if (isRealVendorValue(value)) return value;
  }

  const labelledVendor = firstMatch(clean, [
    /(?:vendor|supplier|merchant|seller|from|bill\s*from)\s*[:#-]?\s*([A-Za-z0-9 &().,'/-]{3,80}?)(?=\s+(?:invoice|inv|document|doc|date|vat|tax|total|amount|balance)\b|$|\n)/i,
    /(?:vendor|supplier|merchant|seller|from|bill\s*from)\s*[:#-]?\s*([^\n]{3,80})/i,
  ]);
  if (isRealVendorValue(labelledVendor)) return cleanVendorValue(labelledVendor);

  return firstMatch(clean, [
    /^([A-Z][A-Za-z0-9 &().,'/-]{2,80}(?:Pty|Ltd|Limited|Inc|LLC|SA|South Africa)[^\n]*)/m,
  ]);
}

function extractVatAmount(compact = "") {
  const subtotalVatTotal = compact.match(
    /sub[-\s]?total\s+vat\s+total\s+(?:ZAR|R)?\s*(-?\d[\d\s,]*(?:\.\d{1,2})?)\s+(?:ZAR|R)?\s*(-?\d[\d\s,]*(?:\.\d{1,2})?)\s+(?:ZAR|R)?\s*(-?\d[\d\s,]*(?:\.\d{1,2})?)/i,
  );
  if (subtotalVatTotal) return parseMoney(subtotalVatTotal[2]);

  return parseMoney(firstMatch(compact, [
    /(?:vat|tax)\s*(?:amount)?\s*[:#-]?\s*(?:ZAR|R)?\s*(-?\d[\d\s,]*(?:\.\d{1,2})?)/i,
  ]));
}

function normalizeExtracted(extracted, requestedType) {
  const docType = validateDocumentType(extracted.document_type) || requestedType || "invoice";
  return {
    vendor_name: String(extracted.vendor_name || extracted.vendor || "").trim(),
    invoice_number: String(extracted.invoice_number || extracted.document_number || "").trim(),
    invoice_date: toIsoDate(extracted.invoice_date || extracted.date || ""),
    total_amount: parseMoney(extracted.total_amount ?? extracted.amount ?? ""),
    vat_amount: parseMoney(extracted.vat_amount ?? extracted.vat ?? ""),
    document_type: docType,
  };
}

function ruleBasedExtract(text = "", requestedType = "invoice") {
  const clean = String(text || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ");
  const compact = clean.replace(/\n+/g, " ");
  const docType =
    /credit\s*note|credit\s*memo|\bcn[-\s#:]/i.test(compact) ? "credit_note" :
    /tax\s*invoice|invoice|\binv[-\s#:]/i.test(compact) ? "invoice" :
    requestedType;

  const invoiceNumber = firstMatch(compact, [
    /(?:invoice|inv|document|doc|credit\s*note|cn)\s*(?:number|no|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{2,})/i,
    /(?:invoice|inv|document|doc|credit\s*note|cn)\s*[:#-]\s*([A-Z0-9][A-Z0-9/-]{2,})/i,
    /\binvoice\s+(\d{6,})\b/i,
    /\b((?:INV|CN|CRN|TAX|DOC)[-\s]?[A-Z0-9-]{3,})\b/i,
  ]);

  const date = toIsoDate(firstMatch(compact, [
    /(?:invoice|document|credit\s*note|tax)?\s*date\s*[:#-]?\s*([0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4})/i,
    /\b([0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2})\b/,
    /\b([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})\b/,
  ]));

  const vendor = extractVendorFromText(clean, compact);
  const vat = extractVatAmount(compact);

  const total = parseMoney(firstMatch(compact, [
    /(?:grand\s*total|total\s*due|amount\s*due|total\s*amount|balance\s*due|total)\s*[:#-]?\s*(?:ZAR|R)?\s*(-?\d[\d\s,]*(?:\.\d{1,2})?)/i,
    /(?:ZAR|R)\s*(-?\d[\d\s,]*(?:\.\d{1,2})?)\s*(?:incl|including|total)?/i,
  ]));

  const populated = [vendor, invoiceNumber, date, total, vat].filter((v) => v !== "" && v !== null && v !== undefined).length;
  const confidence = Math.min(0.92, 0.25 + populated * 0.13 + (text.length > 80 ? 0.12 : 0));

  return {
    extracted: normalizeExtracted({
      vendor_name: vendor,
      invoice_number: invoiceNumber,
      invoice_date: date,
      total_amount: total,
      vat_amount: vat,
      document_type: docType,
    }, requestedType),
    confidence: Number(confidence.toFixed(2)),
    notes: populated
      ? "Rule-based extraction from OCR/text. Review and correct before submitting."
      : "No reliable text found. Enter or correct fields manually before submitting.",
    method: "ocr_rules",
    textLength: text.length,
  };
}

function mergeExtracted(base, enhancement, requestedType) {
  const normalized = normalizeExtracted(enhancement || {}, requestedType);
  return {
    vendor_name: normalized.vendor_name || base.vendor_name,
    invoice_number: normalized.invoice_number || base.invoice_number,
    invoice_date: normalized.invoice_date || base.invoice_date,
    total_amount: normalized.total_amount ?? base.total_amount,
    vat_amount: normalized.vat_amount ?? base.vat_amount,
    document_type: normalized.document_type || base.document_type,
  };
}

function stripJsonFences(text = "") {
  return String(text || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function readBalancedJsonBlock(text, start) {
  const expectedClosers = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") expectedClosers.push("}");
    else if (ch === "[") expectedClosers.push("]");
    else if (ch === "}" || ch === "]") {
      if (expectedClosers[expectedClosers.length - 1] !== ch) return "";
      expectedClosers.pop();
      if (!expectedClosers.length) return text.slice(start, i + 1);
    }
  }

  return "";
}

function parseJsonFromText(text = "") {
  const clean = stripJsonFences(text);
  let lastError = null;

  for (let i = 0; i < clean.length; i += 1) {
    if (clean[i] !== "{" && clean[i] !== "[") continue;
    const block = readBalancedJsonBlock(clean, i);
    if (!block) continue;
    try {
      return JSON.parse(block);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(lastError ? `Invalid JSON in AI response: ${lastError.message}` : "No complete JSON block in AI response");
}

function parseExtractionJson(text = "") {
  const parsed = parseJsonFromText(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI extraction response was not a JSON object");
  }
  return parsed;
}

function parseInsightsJson(text = "") {
  const parsed = parseJsonFromText(text);
  const insights = Array.isArray(parsed) ? parsed : parsed?.insights;
  if (!Array.isArray(insights)) throw new Error("AI insights response did not contain an insights array");
  const clean = insights.map((item) => String(item || "").trim()).filter(Boolean);
  if (!clean.length) throw new Error("AI insights response was empty");
  return clean.slice(0, 8);
}

async function fetchWithAiTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = Number.isFinite(AI_PROVIDER_TIMEOUT_MS) && AI_PROVIDER_TIMEOUT_MS > 0 ? AI_PROVIDER_TIMEOUT_MS : 18000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractionResponse(result, { attempted = [], used = null, method = null, notes = null } = {}) {
  const extractionMethod = method || result.method || "ocr_rules_fallback";
  const extractionNotes = notes || result.notes || "OCR/rule extraction is available for manual correction.";
  return {
    ...result,
    method: extractionMethod,
    notes: extractionNotes,
    extraction_method: extractionMethod,
    extraction_confidence: result.confidence || 0,
    ai_provider_attempted: attempted,
    ai_provider_used: used,
    extraction_notes: extractionNotes,
  };
}

function logExtractionProvider(provider, status, details = {}) {
  const parts = [`extraction provider=${provider}`, `status=${status}`];
  if (details.reason) parts.push(`reason=${details.reason}`);
  if (details.method) parts.push(`method=${details.method}`);
  if (details.fallbackMethod) parts.push(`fallback_method=${details.fallbackMethod}`);
  if (details.attempted?.length) parts.push(`attempted=${details.attempted.join(",")}`);
  safeDevLog(parts.join(" "));
}

function geminiOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  if (typeof data?.outputText === "string") return data.outputText;
  if (Array.isArray(data?.candidates)) {
    return data.candidates
      .flatMap((candidate) => candidate?.content?.parts || [])
      .map((part) => part?.text || "")
      .filter(Boolean)
      .join("\n");
  }

  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === "text" || key === "output_text" || key === "outputText") && typeof value === "string") found.push(value);
      else if (typeof value === "object") visit(value);
    }
  };
  visit(data);
  return found.join("\n");
}

async function callGemini({ input, systemInstruction, temperature = 0.1 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const upstream = await fetchWithAiTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction || "" }],
      },
      contents: [{
        role: "user",
        parts: [{ text: input }],
      }],
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
      },
    }),
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const message = data?.error?.message || "Gemini API error";
    throw new Error(message);
  }

  const text = geminiOutputText(data);
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

async function enhanceExtractionWithGemini({ ocrText, requestedType, baseline }) {
  const raw = await callGemini({
    systemInstruction: "You extract invoice and credit note fields. Return only valid JSON. Do not invent missing values.",
    input:
      "Extract fields from this invoice or credit note. Return only JSON with keys: " +
      "vendor_name, invoice_number, invoice_date (YYYY-MM-DD), total_amount, vat_amount, document_type. " +
      `Expected document_type is ${requestedType}. OCR/rule text:\n${String(ocrText || "").slice(0, 12000)}`,
    temperature: 0,
  });
  let ai;
  try {
    ai = parseExtractionJson(raw);
  } catch (err) {
    throw new Error(`Gemini parse failed: ${err.message}`);
  }
  return {
    extracted: mergeExtracted(baseline.extracted, ai, requestedType),
    confidence: Math.max(baseline.confidence, 0.86),
    notes: "Gemini free-tier cleanup applied on top of OCR/rule extraction. Review and correct before submitting.",
    method: "ocr_rules_gemini",
    textLength: baseline.textLength,
  };
}

async function enhanceExtractionWithOpenRouter({ ocrText, requestedType, baseline }) {
  const raw = await requestOpenRouterJson({
    system:
      "You clean OCR/rule extraction for invoice and credit note data. Return strict JSON only. " +
      "Do not invent missing values. Use null for unknown values.",
    user:
      "Clean this extraction. Return JSON only with exactly these keys: " +
      "vendor, invoice_number, date, amount, vat, document_type, confidence, notes. " +
      "document_type must be invoice or credit_note. date must be YYYY-MM-DD or null. " +
      `Expected document_type is ${requestedType}. Baseline extraction:\n${JSON.stringify(baseline.extracted)}\n\nOCR/rule text:\n${String(ocrText || "").slice(0, 12000)}`,
    temperature: 0,
    maxTokens: 900,
  });
  let ai;
  try {
    ai = parseExtractionJson(raw);
  } catch (err) {
    throw new Error(`OpenRouter parse failed: ${err.message}`);
  }
  return {
    extracted: mergeExtracted(baseline.extracted, ai, requestedType),
    confidence: Math.max(baseline.confidence, Number(ai.confidence) || 0.82),
    notes: ai.notes || "OpenRouter cleanup applied on top of OCR/rule extraction. Review and correct before submitting.",
    method: "ocr_rules_openrouter",
    textLength: baseline.textLength,
  };
}

function summarizeReportData(docs = []) {
  const byVendor = {};
  const byMonth = {};
  const byStatus = {};
  const currentDate = new Date().toISOString().slice(0, 10);
  const currentTime = Date.parse(`${currentDate}T00:00:00Z`);
  const datedDocuments = [];
  let total = 0;
  let vat = 0;

  docs.forEach((d) => {
    const vendor = d.extracted?.vendor_name || "Unknown";
    const amount = Number(d.extracted?.total_amount) || 0;
    const vatAmount = Number(d.extracted?.vat_amount) || 0;
    const date = toIsoDate(d.extracted?.invoice_date || "") || String(d.uploadDate || "").slice(0, 10);
    const month = date ? date.slice(0, 7) : "unknown";
    total += amount;
    vat += vatAmount;
    byVendor[vendor] = (byVendor[vendor] || 0) + amount;
    byMonth[month] = (byMonth[month] || 0) + amount;
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      datedDocuments.push({
        fileName: d.fileName,
        vendor,
        invoiceNumber: d.extracted?.invoice_number || "",
        date,
        month,
        amount,
        isFutureDated: Date.parse(`${date}T00:00:00Z`) > currentTime,
      });
    }
  });

  const sortedDates = [...datedDocuments].sort((a, b) => a.date.localeCompare(b.date));
  const monthStats = Object.entries(byMonth)
    .filter(([month]) => month !== "unknown")
    .map(([month, amount]) => ({
      month,
      amount: Number(amount.toFixed(2)),
      count: datedDocuments.filter((doc) => doc.month === month).length,
    }))
    .sort((a, b) => b.count - a.count || b.amount - a.amount || a.month.localeCompare(b.month));
  const dominantMonth = monthStats[0] || null;
  const nonFutureDocuments = datedDocuments.filter((doc) => !doc.isFutureDated);
  const outsideMainDateRange = dominantMonth
    ? nonFutureDocuments.filter((doc) => doc.month !== dominantMonth.month)
    : [];
  const vatDocs = docs
    .map((d) => {
      const gross = Number(d.extracted?.total_amount) || 0;
      const vatAmount = Number(d.extracted?.vat_amount);
      const net = gross - vatAmount;
      const vatRate = Number.isFinite(vatAmount) && gross > 0 && net > 0 ? vatAmount / net : null;
      return { vendor: d.extracted?.vendor_name || "Unknown", gross, vatAmount, vatRate };
    })
    .filter((d) => Number.isFinite(d.vatRate));
  const standardVatDocs = vatDocs.filter((d) => d.vatRate >= 0.145 && d.vatRate <= 0.155);

  return {
    count: docs.length,
    currentDate,
    total: Number(total.toFixed(2)),
    vat: Number(vat.toFixed(2)),
    duplicateCount: docs.filter((d) => d.isDup).length,
    rejectedCount: docs.filter((d) => d.status === "rejected").length,
    pendingCount: docs.filter((d) => String(d.status).startsWith("pending")).length,
    approvedCount: docs.filter((d) => d.status === "approved").length,
    byVendor,
    byMonth,
    byStatus,
    dateStats: {
      currentDate,
      datedCount: datedDocuments.length,
      earliest: sortedDates[0]?.date || null,
      latest: sortedDates[sortedDates.length - 1]?.date || null,
      dominantMonth: dominantMonth?.month || null,
      futureDatedDocuments: datedDocuments.filter((doc) => doc.isFutureDated).slice(0, 8),
      outsideMainDateRange: outsideMainDateRange.slice(0, 8),
    },
    vatStats: {
      docsWithCalculableVatRate: vatDocs.length,
      standardVatDocs: standardVatDocs.length,
      canCallStandardVatConsistent: vatDocs.length > 0 && standardVatDocs.length === vatDocs.length,
      rates: vatDocs.slice(0, 8).map((doc) => ({
        vendor: doc.vendor,
        ratePercent: Number((doc.vatRate * 100).toFixed(2)),
      })),
    },
  };
}

function money(n) {
  return `R ${Number(n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthLabel(month = "") {
  if (!/^\d{4}-\d{2}$/.test(month)) return month || "unknown month";
  const d = new Date(`${month}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

function sanitizeInsightText(text = "", summary = {}) {
  let out = String(text || "").trim();
  out = out
    .replace(/\bprojected\b/gi, "recorded")
    .replace(/\bprojections?\b/gi, "recorded values")
    .replace(/\bforecasts?\b/gi, "recorded observations")
    .replace(/\bforecasted\b/gi, "recorded")
    .replace(/\bforecasting\b/gi, "observed analysis");

  if (!summary.dateStats?.futureDatedDocuments?.length) {
    out = out
      .replace(/\bfar in the future\b/gi, "outside the main date range")
      .replace(/\bin the future\b/gi, "outside the main date range")
      .replace(/\bfuture[-\s]?dated\b/gi, "date-outlier")
      .replace(/\bfuture\b/gi, "observed");
  }
  return out;
}

function sanitizeInsights(insights = [], summary = {}) {
  return insights
    .map((insight) => sanitizeInsightText(insight, summary))
    .filter(Boolean)
    .slice(0, 8);
}

function ruleBasedInsights(docs = []) {
  const summary = summarizeReportData(docs);
  if (!summary.count) return ["No report data is available yet. Upload demo documents to generate insights."];

  const vendors = Object.entries(summary.byVendor).sort((a, b) => b[1] - a[1]);
  const months = Object.entries(summary.byMonth).sort((a, b) => a[0].localeCompare(b[0]));
  const topVendor = vendors[0];
  const avg = summary.total / summary.count;
  const largestDoc = [...docs].sort((a, b) => (Number(b.extracted?.total_amount) || 0) - (Number(a.extracted?.total_amount) || 0))[0];
  const insights = [
    `${summary.count} submitted document(s) have ${money(summary.total)} captured in total, with ${money(summary.vat)} recorded as VAT.`,
  ];

  if (topVendor) {
    const pct = summary.total ? (topVendor[1] / summary.total) * 100 : 0;
    insights.push(`${topVendor[0]} is the largest vendor at ${money(topVendor[1])}, representing ${pct.toFixed(1)}% of filtered spend.`);
  }

  if (largestDoc && Number(largestDoc.extracted?.total_amount) > avg * 1.6 && summary.count > 1) {
    insights.push(`${largestDoc.extracted?.vendor_name || largestDoc.fileName} is an anomaly candidate at ${money(largestDoc.extracted?.total_amount)}, above the average of ${money(avg)}.`);
  } else {
    insights.push(`Average document value is ${money(avg)} across the current report set.`);
  }

  if (summary.dateStats.futureDatedDocuments.length) {
    const doc = summary.dateStats.futureDatedDocuments[0];
    insights.push(`${summary.dateStats.futureDatedDocuments.length} future-dated document(s) appear after ${summary.currentDate}; first review item is ${doc.vendor} dated ${doc.date}.`);
  } else if (summary.dateStats.outsideMainDateRange.length === 1) {
    insights.push("One document date appears outside the main date range.");
  } else if (summary.dateStats.dominantMonth) {
    insights.push(`Spending is concentrated around ${monthLabel(summary.dateStats.dominantMonth)} based on submitted documents.`);
  } else if (months.length > 1) {
    const first = months[0];
    const last = months[months.length - 1];
    insights.push(`Recorded spend spans ${monthLabel(first[0])} to ${monthLabel(last[0])} based on submitted document dates.`);
  }

  if (summary.duplicateCount) {
    insights.push(`${summary.duplicateCount} duplicate or possible duplicate document(s) should be reviewed before final approval.`);
  } else {
    insights.push("No duplicate flags are present in the current report set.");
  }

  if (summary.pendingCount > summary.approvedCount + summary.rejectedCount) {
    insights.push("Most documents are still pending approval, indicating a workflow backlog.");
  } else {
    insights.push(`${summary.pendingCount} pending, ${summary.approvedCount} approved, and ${summary.rejectedCount} rejected document(s) are visible in the workflow.`);
  }

  if (summary.vatStats.canCallStandardVatConsistent) {
    insights.push("VAT entries are consistent with the standard VAT rate based on calculable document VAT percentages.");
  } else if (summary.vatStats.docsWithCalculableVatRate) {
    insights.push("VAT percentages vary across submitted documents; review any zero-rated or unusual VAT entries before final reporting.");
  }

  return sanitizeInsights(insights, summary).slice(0, 6);
}

app.get("/", (_req, res) => {
  res.send("DocFlow server is running. Use /health or /api endpoints.");
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });
    const u = await db.getUserByUsername(username);
    if (!u) return res.status(401).json({ error: "Invalid credentials" });
    if (!bcrypt.compareSync(password, u.passwordHash)) return res.status(401).json({ error: "Invalid credentials" });
    const token = signToken(u);
    return res.json({
      token,
      user: { id: u.id, username: u.username, role: u.role, name: u.name, approvalStep: u.approvalStep, stepLabel: u.stepLabel },
    });
  } catch (e) {
    console.error("Login failed:", e);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/docs", authMiddleware, async (_req, res) => {
  try {
    const docs = await db.listDocuments();
    res.json(visibleDocumentsForUser(_req.user, docs));
  } catch (e) {
    console.error("Document list failed:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/extract", authMiddleware, async (req, res) => {
  if (!canUpload(req.user)) return res.status(403).json({ error: "Upload access is restricted to admin users" });

  const {
    fileName = "document.pdf",
    mimeType = "",
    dataBase64 = "",
    ocrText = "",
    documentType = "invoice",
  } = req.body || {};

  const requestedType = validateDocumentType(documentType);
  if (!requestedType) return res.status(400).json({ error: "Document type must be invoice or credit_note" });
  const fileError = validateUploadFile({ fileName, mimeType });
  if (fileError) return res.status(400).json({ error: fileError });

  const extractedText = [
    String(ocrText || ""),
    extractTextFromUpload(dataBase64, mimeType),
    fileName,
  ].join("\n");

  const baseline = ruleBasedExtract(extractedText, requestedType);
  const attempted = [];

  if (process.env.GEMINI_API_KEY) {
    attempted.push("gemini");
    logExtractionProvider("gemini", "attempted", { method: "ocr_rules_gemini", attempted });
    try {
      const enhanced = await enhanceExtractionWithGemini({
        ocrText: extractedText,
        requestedType,
        baseline,
      });
      logExtractionProvider("gemini", "success", { method: "ocr_rules_gemini", attempted });
      return res.json(extractionResponse(enhanced, { attempted, used: "gemini", method: "ocr_rules_gemini" }));
    } catch (e) {
      logExtractionProvider("gemini", "failure", { reason: e.message, fallbackMethod: process.env.OPENROUTER_API_KEY ? "openrouter_next" : "ocr_rules_fallback", attempted });
    }
  }

  if (process.env.OPENROUTER_API_KEY) {
    attempted.push("openrouter");
    logExtractionProvider("openrouter", "attempted", { method: "ocr_rules_openrouter", attempted });
    try {
      const enhanced = await enhanceExtractionWithOpenRouter({
        ocrText: extractedText,
        requestedType,
        baseline,
      });
      logExtractionProvider("openrouter", "success", { method: "ocr_rules_openrouter", attempted });
      return res.json(extractionResponse(enhanced, { attempted, used: "openrouter", method: "ocr_rules_openrouter" }));
    } catch (e) {
      logExtractionProvider("openrouter", "failure", { reason: e.message, fallbackMethod: "ocr_rules_fallback", attempted });
    }
  }

  const reason = attempted.length
    ? "AI cleanup was unavailable; OCR/rule extraction is ready for manual correction."
    : "No AI provider key configured; OCR/rule extraction is ready for manual correction.";
  if (attempted.length) {
    logExtractionProvider("fallback", "used", { method: "ocr_rules_fallback", attempted });
  }
  return res.json(extractionResponse({
    ...baseline,
    notes: `${baseline.notes} ${reason}`,
    method: "ocr_rules_fallback",
  }, { attempted, used: null, method: "ocr_rules_fallback" }));
});

app.post("/api/docs", authMiddleware, async (req, res) => {
  if (!canUpload(req.user)) return res.status(403).json({ error: "Upload access is restricted to admin users" });

  try {
    const payload = req.body || {};
    const docType = validateDocumentType(payload.type || payload.extracted?.document_type);
    if (!docType) return res.status(400).json({ error: "Document type must be invoice or credit_note" });

    const fileError = validateUploadFile({ fileName: payload.fileName, mimeType: payload.fileMimeType });
    if (fileError) return res.status(400).json({ error: fileError });

    const rawVat = payload.extracted?.vat_amount ?? payload.extracted?.vat;
    const vatProvided = rawVat !== "" && rawVat !== null && rawVat !== undefined;
    const extracted = normalizeExtracted({ ...(payload.extracted || {}), document_type: docType }, docType);
    const total = Number(extracted.total_amount);
    const vat = Number(extracted.vat_amount);
    if (
      !extracted.vendor_name ||
      !extracted.invoice_number ||
      !isValidIsoDate(extracted.invoice_date) ||
      !Number.isFinite(total) ||
      total <= 0 ||
      (vatProvided && (extracted.vat_amount === null || !Number.isFinite(vat)))
    ) {
      return res.status(400).json({ error: "Vendor, invoice number, valid date, amount greater than 0, and numeric VAT are required before submission" });
    }

    const duplicate = await db.findDuplicateDocuments(extracted, payload.fileHash);
    const doc = await db.createDocument({
      type: docType,
      fileName: payload.fileName || "document.pdf",
      fileMimeType: payload.fileMimeType || null,
      fileHash: payload.fileHash || null,
      uploadedByUserId: req.user.id || null,
      extracted,
      extractionMeta: {
        method: payload.extractionMeta?.method || "manual_or_rules",
        confidence: Number(payload.extractionMeta?.confidence || 0),
        notes: payload.extractionMeta?.notes || "Fields were reviewed before submission.",
      },
      status: "pending_approval_1",
      currentStep: 1,
      isDup: duplicate.dup || Boolean(payload.isDup),
      dupReason: duplicate.reason || payload.dupReason || null,
    });

    res.json(doc);
  } catch (e) {
    console.error("Document create failed:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/docs/:id/decide", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, comment } = req.body || {};
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "action must be approve or reject" });

    const doc = await db.getDocumentById(id);
    if (!doc) return res.status(404).json({ error: "not found" });

    const match = String(doc.status || "").match(/pending_approval_(\d)/);
    const step = match ? Number(match[1]) : null;
    if (!step) return res.status(400).json({ error: "document not awaiting approval" });

    if (req.user.role !== "admin") {
      if (req.user.role !== "approver" || Number(req.user.approvalStep || 0) !== step) {
        return res.status(403).json({ error: "not allowed to act on this step" });
      }
    }
    if (action === "reject" && (!comment || !comment.trim())) {
      return res.status(400).json({ error: "comment required to reject" });
    }

    const role = req.user.stepLabel || (step === 1 ? "Reviewer" : step === 2 ? "Manager" : "Finance/Admin");
    const entry = { stage: step, step, role, action, comment: comment || "" };
    const newStatus = action === "reject" ? "rejected" : step < 3 ? `pending_approval_${step + 1}` : "approved";
    const nextStep = action === "reject" || step >= 3 ? null : step + 1;
    await db.addApprovalHistory(id, entry, req.user.id || null);
    await db.updateDocument(id, { status: newStatus, currentStep: nextStep });
    res.json({ ok: true });
  } catch (e) {
    console.error("Approval decision failed:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/docs/:id", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  try {
    const { id } = req.params;
    await db.deleteDocument(id);
    res.json({ ok: true });
  } catch (e) {
    console.error("Document delete failed:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/reports", authMiddleware, async (req, res) => {
  if (!canViewReports(req.user)) return res.status(403).json({ error: "Reports access is restricted for this role" });
  try {
    res.json(await db.getReportData(req.query));
  } catch (e) {
    console.error("Report query failed:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/insights", authMiddleware, async (req, res) => {
  if (!canViewInsights(req.user)) return res.status(403).json({ error: "Insights access is restricted for this role" });
  try {
    const docs = await db.getReportData(req.body?.filters || {});
    const fallback = ruleBasedInsights(docs);
    const summary = summarizeReportData(docs);

    if (process.env.GEMINI_API_KEY) {
      try {
        const raw = await callGemini({
          systemInstruction:
            "You are a financial analyst. Return strict JSON only: {\"insights\":[\"...\"]}. " +
            "Use observed submitted document data only. Do not forecast. Do not use words like projected, forecast, or future unless the summary has futureDatedDocuments after currentDate. " +
            "If a date is before or on currentDate, never call it future; call it an outlier only when appropriate.",
          input:
            "Use only this Supabase report summary to give 5 concise financial insights about observed spend, date range, anomalies, vendor concentration, approval status, and VAT. " +
            "Do not invent totals, vendors, VAT values, approval counts, anomalies, trends, projections, or forecasts. " +
            "Only say VAT is consistent with standard VAT when vatStats.canCallStandardVatConsistent is true. " +
            "Prefer phrasing like: Spending is concentrated around [month/year] based on submitted documents; One document date appears outside the main date range; Most documents are still pending approval, indicating a workflow backlog.\n" +
            JSON.stringify(summary),
          temperature: 0.2,
        });
        const insights = sanitizeInsights(parseInsightsJson(raw), summary);
        return res.json({ insights, method: "gemini", ai_provider_used: "gemini", notes: "Gemini free-tier insights generated from submitted report data." });
      } catch (e) {
        safeDevLog("Gemini insights failed", e);
      }
    }

    if (process.env.OPENROUTER_API_KEY) {
      try {
        const raw = await requestOpenRouterJson({
          system:
            "You are a financial analyst. Return strict JSON only: {\"insights\":[\"...\"]}. " +
            "Use observed submitted document data only. Do not forecast. Do not use words like projected, forecast, or future unless the summary has futureDatedDocuments after currentDate. " +
            "If a date is before or on currentDate, never call it future; call it an outlier only when appropriate.",
          user:
            "Use only this Supabase report summary to give 5 concise insights about observed spend, date range, anomalies, vendor concentration, approval status, and VAT. " +
            "Do not invent totals, vendors, VAT values, approval counts, anomalies, trends, projections, or forecasts. " +
            "Only say VAT is consistent with standard VAT when vatStats.canCallStandardVatConsistent is true. " +
            "Prefer phrasing like: Spending is concentrated around [month/year] based on submitted documents; One document date appears outside the main date range; Most documents are still pending approval, indicating a workflow backlog.\n" +
            JSON.stringify(summary),
          temperature: 0.2,
          maxTokens: 900,
        });
        const insights = sanitizeInsights(parseInsightsJson(raw), summary);
        return res.json({ insights, method: "openrouter", ai_provider_used: "openrouter", notes: "OpenRouter fallback insights generated from submitted report data." });
      } catch (e) {
        safeDevLog("OpenRouter insights failed", e);
      }
    }

    return res.json({ insights: fallback, method: "rule_based", ai_provider_used: null, notes: "No AI provider completed; deterministic report insights were used." });
  } catch (e) {
    console.error("Insights report query failed:", e);
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/gemini", authMiddleware, async (req, res) => {
  if (!canViewInsights(req.user)) return res.status(403).json({ error: "AI access is restricted for this role" });
  try {
    const { input, systemInstruction } = req.body || {};
    if (!input) return res.status(400).json({ error: "input is required" });
    const text = await callGemini({ input, systemInstruction });
    res.json({ content: [{ type: "text", text }] });
  } catch (err) {
    const code = err.message.includes("GEMINI_API_KEY") ? 500 : 502;
    res.status(code).json({ error: err.message });
  }
});

app.post("/api/openrouter", authMiddleware, async (req, res) => {
  if (!canViewInsights(req.user)) return res.status(403).json({ error: "AI access is restricted for this role" });
  try {
    const { input, systemInstruction } = req.body || {};
    if (!input) return res.status(400).json({ error: "input is required" });
    const text = await requestOpenRouterJson({
      system: systemInstruction || "Return strict JSON only.",
      user: input,
      temperature: 0,
    });
    res.json({ content: [{ type: "text", text }] });
  } catch (err) {
    const code = err.message.includes("OPENROUTER_API_KEY") ? 500 : 502;
    res.status(code).json({ error: err.message });
  }
});

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("Request failed:", err);
  const isCorsError = err?.message?.startsWith("CORS:");
  res.status(isCorsError ? 403 : 500).json({ error: isCorsError ? err.message : "Internal server error" });
});

const server = app.listen(PORT, () => console.log(`DocFlow server running on port ${PORT}`));
server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the old DocFlow server process or set PORT=3002 in server/.env.`);
    process.exit(1);
  }
  console.error("DocFlow server failed to start:", err);
  process.exit(1);
});
