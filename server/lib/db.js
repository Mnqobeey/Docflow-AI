const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

let supabaseClient = null;

function getClient() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the backend.");
  }

  supabaseClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    realtime: {
      transport: WebSocket,
    },
  });
  return supabaseClient;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function stepFromStatus(status) {
  const match = String(status || "").match(/pending_approval_(\d)/);
  return match ? Number(match[1]) : null;
}

function userRowToApp(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    name: row.display_name || row.username,
    approvalStep: row.approval_step || null,
    stepLabel: row.step_label || null,
  };
}

function approvalRowToApp(row, usersById = {}) {
  const user = usersById[row.user_id] || {};
  return {
    stage: row.stage,
    step: row.stage,
    role: row.role,
    action: row.action,
    user: user.username || null,
    approverName: user.display_name || user.username || "Unknown user",
    approverRole: row.role,
    comment: row.comment || "",
    timestamp: row.created_at,
  };
}

function documentRowToApp(row, approvals = [], usersById = {}) {
  const uploader = usersById[row.uploaded_by] || {};
  const status = row.status || (row.current_step ? `pending_approval_${row.current_step}` : "pending_approval_1");
  return {
    id: row.id,
    type: row.document_type,
    fileName: row.file_name || "document.pdf",
    fileMimeType: row.file_type || null,
    fileHash: row.file_hash || null,
    uploadedBy: uploader.display_name || uploader.username || "Unknown user",
    uploadDate: row.created_at,
    extracted: {
      vendor_name: row.vendor || "",
      invoice_number: row.invoice_number || "",
      invoice_date: row.invoice_date || "",
      total_amount: toNumber(row.amount, 0),
      vat_amount: toNumber(row.vat, 0),
      document_type: row.document_type,
    },
    extractionMeta: {
      method: row.extraction_method || "manual_or_rules",
      confidence: row.extraction_confidence === null || row.extraction_confidence === undefined ? 0 : toNumber(row.extraction_confidence, 0),
      notes: row.extraction_notes || "",
    },
    status,
    currentStep: row.current_step || stepFromStatus(status),
    isDup: Boolean(row.duplicate_status),
    dupReason: row.duplicate_reason || null,
    approvals,
  };
}

async function assertOk(result, label) {
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  return result.data;
}

async function getUserByUsername(username) {
  const supabase = getClient();
  const result = await supabase
    .from("users")
    .select("*")
    .eq("username", String(username || "").trim().toLowerCase())
    .maybeSingle();
  return userRowToApp(await assertOk(result, "get user by username"));
}

async function getUserById(id) {
  if (!id) return null;
  const supabase = getClient();
  const result = await supabase.from("users").select("*").eq("id", id).maybeSingle();
  return userRowToApp(await assertOk(result, "get user by id"));
}

async function getUsersByIds(ids) {
  const clean = [...new Set((ids || []).filter(Boolean))];
  if (!clean.length) return {};
  const supabase = getClient();
  const result = await supabase.from("users").select("id, username, display_name, role, approval_step, step_label").in("id", clean);
  const rows = await assertOk(result, "get users by ids");
  return Object.fromEntries((rows || []).map((row) => [row.id, row]));
}

async function loadDocumentsByRows(rows) {
  const docRows = rows || [];
  if (!docRows.length) return [];

  const docIds = docRows.map((row) => row.id);
  const approvalsResult = await getClient()
    .from("approval_history")
    .select("*")
    .in("document_id", docIds)
    .order("created_at", { ascending: true });
  const approvals = await assertOk(approvalsResult, "list approval history");

  const userIds = [
    ...docRows.map((row) => row.uploaded_by),
    ...(approvals || []).map((row) => row.user_id),
  ];
  const usersById = await getUsersByIds(userIds);

  const approvalsByDoc = {};
  (approvals || []).forEach((row) => {
    approvalsByDoc[row.document_id] = approvalsByDoc[row.document_id] || [];
    approvalsByDoc[row.document_id].push(approvalRowToApp(row, usersById));
  });

  return docRows.map((row) => documentRowToApp(row, approvalsByDoc[row.id] || [], usersById));
}

async function listDocuments() {
  const result = await getClient()
    .from("documents")
    .select("*")
    .order("created_at", { ascending: true });
  const rows = await assertOk(result, "list documents");
  return loadDocumentsByRows(rows);
}

async function getDocumentById(id) {
  const result = await getClient().from("documents").select("*").eq("id", id).maybeSingle();
  const row = await assertOk(result, "get document by id");
  if (!row) return null;
  const docs = await loadDocumentsByRows([row]);
  return docs[0] || null;
}

async function insertAndLoadDocument(insertRow) {
  const result = await getClient().from("documents").insert(insertRow).select("*").single();
  const row = await assertOk(result, "create document");
  const docs = await loadDocumentsByRows([row]);
  return docs[0];
}

async function createDocument(payload) {
  const status = payload.status || "pending_approval_1";
  const currentStep = payload.currentStep || stepFromStatus(status) || 1;
  return insertAndLoadDocument({
    document_type: payload.type,
    vendor: payload.extracted.vendor_name,
    invoice_number: payload.extracted.invoice_number,
    invoice_date: payload.extracted.invoice_date || null,
    amount: payload.extracted.total_amount,
    vat: payload.extracted.vat_amount || 0,
    status,
    current_step: currentStep,
    file_name: payload.fileName || "document.pdf",
    file_type: payload.fileMimeType || null,
    file_hash: payload.fileHash || null,
    duplicate_status: payload.isDup ? "duplicate" : null,
    duplicate_reason: payload.dupReason || null,
    extraction_method: payload.extractionMeta?.method || "manual_or_rules",
    extraction_confidence: payload.extractionMeta?.confidence ?? null,
    extraction_notes: payload.extractionMeta?.notes || null,
    uploaded_by: payload.uploadedByUserId || null,
  });
}

async function updateDocument(id, updates) {
  const patch = {};
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.currentStep !== undefined) patch.current_step = updates.currentStep;
  if (updates.duplicateStatus !== undefined) patch.duplicate_status = updates.duplicateStatus;
  if (updates.duplicateReason !== undefined) patch.duplicate_reason = updates.duplicateReason;
  patch.updated_at = new Date().toISOString();

  const result = await getClient().from("documents").update(patch).eq("id", id).select("*").single();
  const row = await assertOk(result, "update document");
  const docs = await loadDocumentsByRows([row]);
  return docs[0];
}

async function deleteDocument(id) {
  const result = await getClient().from("documents").delete().eq("id", id);
  await assertOk(result, "delete document");
  return true;
}

async function addApprovalHistory(documentId, entry, userId) {
  const result = await getClient().from("approval_history").insert({
    document_id: documentId,
    stage: entry.step || entry.stage,
    role: entry.role || entry.approverRole,
    action: entry.action,
    user_id: userId || null,
    comment: entry.comment || null,
  }).select("*").single();
  return assertOk(result, "add approval history");
}

async function getApprovalHistory(documentId) {
  const result = await getClient()
    .from("approval_history")
    .select("*")
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });
  const rows = await assertOk(result, "get approval history");
  const usersById = await getUsersByIds((rows || []).map((row) => row.user_id));
  return (rows || []).map((row) => approvalRowToApp(row, usersById));
}

function duplicateResult(type, row) {
  if (!row) return null;
  if (type === "file") return { dup: true, reason: `Exact file already uploaded ("${row.file_name || "document"}")` };
  if (type === "invoice") return { dup: true, reason: `Invoice #${row.invoice_number} already exists in the system` };
  return { dup: true, reason: "Same vendor and amount already on file - possible duplicate" };
}

async function findDuplicateDocuments(extracted = {}, fileHash) {
  const supabase = getClient();
  const active = (query) => query.neq("status", "rejected").limit(1);

  if (fileHash) {
    const result = await active(supabase.from("documents").select("*").eq("file_hash", fileHash)).maybeSingle();
    const row = await assertOk(result, "duplicate file check");
    const duplicate = duplicateResult("file", row);
    if (duplicate) return duplicate;
  }

  const invoiceNumber = String(extracted.invoice_number || "").trim();
  if (invoiceNumber) {
    const result = await active(supabase.from("documents").select("*").ilike("invoice_number", invoiceNumber)).maybeSingle();
    const row = await assertOk(result, "duplicate invoice check");
    const duplicate = duplicateResult("invoice", row);
    if (duplicate) return duplicate;
  }

  const vendor = String(extracted.vendor_name || "").trim();
  const amount = Number(extracted.total_amount);
  if (vendor && Number.isFinite(amount) && amount > 0) {
    const result = await active(
      supabase
        .from("documents")
        .select("*")
        .ilike("vendor", vendor)
        .eq("amount", amount)
    ).maybeSingle();
    const row = await assertOk(result, "duplicate vendor amount check");
    const duplicate = duplicateResult("vendor_amount", row);
    if (duplicate) return duplicate;
  }

  return { dup: false, reason: null };
}

async function getReportData(filters = {}) {
  let rows = await listDocuments();
  const { from, to, vendor, status, minAmount, maxAmount, type } = filters;
  rows = rows.filter((d) => {
    const date = d.extracted?.invoice_date || d.uploadDate.slice(0, 10);
    if (from && date < from) return false;
    if (to && date > to) return false;
    if (vendor && !(d.extracted?.vendor_name || "").toLowerCase().includes(String(vendor).toLowerCase())) return false;
    if (status === "pending" && !String(d.status).startsWith("pending")) return false;
    if (status === "approved" && d.status !== "approved") return false;
    if (status === "rejected" && d.status !== "rejected") return false;
    if (type && type !== "all" && d.type !== type) return false;
    const amt = Number(d.extracted?.total_amount) || 0;
    if (minAmount && amt < Number(minAmount)) return false;
    if (maxAmount && amt > Number(maxAmount)) return false;
    return true;
  });
  return rows;
}

async function assertConnection() {
  const result = await getClient().from("users").select("id").limit(1);
  await assertOk(result, "Supabase connection check");
  return true;
}

module.exports = {
  getClient,
  getUserByUsername,
  getUserById,
  listDocuments,
  getDocumentById,
  createDocument,
  updateDocument,
  deleteDocument,
  addApprovalHistory,
  getApprovalHistory,
  findDuplicateDocuments,
  getReportData,
  assertConnection,
  userRowToApp,
  normalizeText,
};
