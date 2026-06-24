const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: WebSocket },
});

const DEMO_USERS = [
  { username: "admin", password: "admin123", role: "admin", display_name: "Admin User", approval_step: null, step_label: null },
  { username: "reviewer", password: "review123", role: "approver", display_name: "Sarah Naidoo", approval_step: 1, step_label: "Reviewer" },
  { username: "manager", password: "manager123", role: "approver", display_name: "Mike Govender", approval_step: 2, step_label: "Manager" },
  { username: "finance", password: "finance123", role: "approver", display_name: "Finance Admin", approval_step: 3, step_label: "Finance/Admin" },
  { username: "viewer", password: "viewer123", role: "viewer", display_name: "Priya Pillay", approval_step: null, step_label: null },
];

const STEP_LABELS = { 1: "Reviewer", 2: "Manager", 3: "Finance/Admin" };
const APPROVER_BY_STAGE = { 1: "reviewer", 2: "manager", 3: "finance" };

const DEMO_DOCS = [
  {
    document_type: "invoice",
    vendor: "Takealot Online (Pty) Ltd",
    invoice_number: "TAK-2026-1048",
    invoice_date: "2026-01-14",
    amount: 18420.00,
    vat: 2402.61,
    status: "pending_approval_1",
    current_step: 1,
    file_name: "takealot-inv-1048.pdf",
    approvals: [],
  },
  {
    document_type: "invoice",
    vendor: "MTN South Africa",
    invoice_number: "MTN-INV-2026-2217",
    invoice_date: "2026-02-03",
    amount: 7850.50,
    vat: 1023.98,
    status: "pending_approval_1",
    current_step: 1,
    file_name: "mtn-invoice-2217.pdf",
    approvals: [],
  },
  {
    document_type: "invoice",
    vendor: "Vodacom (Pty) Ltd",
    invoice_number: "VOD-INV-2026-3182",
    invoice_date: "2026-02-21",
    amount: 11275.00,
    vat: 1470.65,
    status: "pending_approval_2",
    current_step: 2,
    file_name: "vodacom-inv-3182.pdf",
    approvals: [
      { stage: 1, action: "approve", comment: "Reviewer details confirmed.", created_at: "2026-02-22T09:15:00.000Z" },
    ],
  },
  {
    document_type: "invoice",
    vendor: "Makro Retail (Pty) Ltd",
    invoice_number: "MAK-INV-2026-4410",
    invoice_date: "2026-03-06",
    amount: 29999.99,
    vat: 3913.04,
    status: "pending_approval_3",
    current_step: 3,
    file_name: "makro-inv-4410.pdf",
    approvals: [
      { stage: 1, action: "approve", comment: "Reviewer details confirmed.", created_at: "2026-03-07T08:30:00.000Z" },
      { stage: 2, action: "approve", comment: "Manager approval recorded.", created_at: "2026-03-08T10:20:00.000Z" },
    ],
  },
  {
    document_type: "invoice",
    vendor: "Sanlam",
    invoice_number: "SAN-INV-2026-0927",
    invoice_date: "2026-03-18",
    amount: 42350.75,
    vat: 5524.01,
    status: "approved",
    current_step: null,
    file_name: "sanlam-inv-0927.pdf",
    approvals: [
      { stage: 1, action: "approve", comment: "Reviewer details confirmed.", created_at: "2026-03-19T09:00:00.000Z" },
      { stage: 2, action: "approve", comment: "Manager approval recorded.", created_at: "2026-03-20T11:30:00.000Z" },
      { stage: 3, action: "approve", comment: "Final finance approval recorded.", created_at: "2026-03-21T14:05:00.000Z" },
    ],
  },
  {
    document_type: "credit_note",
    vendor: "Discovery Health",
    invoice_number: "CN-DISC-2026-018",
    invoice_date: "2026-04-02",
    amount: 3450.00,
    vat: 450.00,
    status: "pending_approval_2",
    current_step: 2,
    file_name: "discovery-credit-018.pdf",
    approvals: [
      { stage: 1, action: "approve", comment: "Reviewer details confirmed.", created_at: "2026-04-03T09:45:00.000Z" },
    ],
  },
  {
    document_type: "credit_note",
    vendor: "Shoprite Checkers",
    invoice_number: "CN-SHP-2026-204",
    invoice_date: "2026-04-16",
    amount: 8990.00,
    vat: 1172.61,
    status: "approved",
    current_step: null,
    file_name: "shoprite-credit-204.pdf",
    approvals: [
      { stage: 1, action: "approve", comment: "Reviewer details confirmed.", created_at: "2026-04-17T08:50:00.000Z" },
      { stage: 2, action: "approve", comment: "Manager approval recorded.", created_at: "2026-04-18T10:10:00.000Z" },
      { stage: 3, action: "approve", comment: "Final finance approval recorded.", created_at: "2026-04-19T15:25:00.000Z" },
    ],
  },
  {
    document_type: "credit_note",
    vendor: "Standard Bank",
    invoice_number: "CN-STB-2026-077",
    invoice_date: "2026-05-07",
    amount: 5750.25,
    vat: 750.03,
    status: "rejected",
    current_step: null,
    file_name: "standard-bank-credit-077.pdf",
    approvals: [
      { stage: 1, action: "approve", comment: "Reviewer details confirmed.", created_at: "2026-05-08T09:20:00.000Z" },
      { stage: 2, action: "approve", comment: "Manager approval recorded.", created_at: "2026-05-09T12:00:00.000Z" },
      { stage: 3, action: "reject", comment: "Credit note value requires revised supporting documentation.", created_at: "2026-05-10T13:35:00.000Z" },
    ],
  },
];

async function upsertDemoUsers() {
  const rows = DEMO_USERS.map((user) => ({
    username: user.username,
    password_hash: bcrypt.hashSync(user.password, 10),
    display_name: user.display_name,
    role: user.role,
    approval_step: user.approval_step,
    step_label: user.step_label,
  }));

  const { data, error } = await supabase
    .from("users")
    .upsert(rows, { onConflict: "username" })
    .select("id, username");

  if (error) throw error;
  console.log(`Seeded ${data.length} demo user(s).`);
  return Object.fromEntries(data.map((row) => [row.username, row.id]));
}

async function seedDemoDocuments(adminId, userIds) {
  for (const doc of DEMO_DOCS) {
    const existing = await supabase
      .from("documents")
      .select("id")
      .eq("invoice_number", doc.invoice_number)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      console.log(`Skipped existing demo document ${doc.invoice_number}.`);
      continue;
    }

    const { approvals, ...docRow } = doc;
    const { data, error } = await supabase.from("documents").insert({
      ...docRow,
      file_type: "application/pdf",
      file_hash: `seed-${doc.invoice_number.toLowerCase()}`,
      duplicate_status: null,
      duplicate_reason: null,
      extraction_method: "sample_document",
      extraction_confidence: 1,
      extraction_notes: "Sample document details loaded for reviewer testing.",
      uploaded_by: adminId,
      created_at: `${doc.invoice_date}T08:00:00.000Z`,
    }).select("id").single();
    if (error) throw error;

    if (approvals?.length) {
      const historyRows = approvals.map((entry) => ({
        document_id: data.id,
        stage: entry.stage,
        role: STEP_LABELS[entry.stage],
        action: entry.action,
        user_id: userIds[APPROVER_BY_STAGE[entry.stage]],
        comment: entry.comment,
        created_at: entry.created_at,
      }));
      const historyResult = await supabase.from("approval_history").insert(historyRows);
      if (historyResult.error) throw historyResult.error;
    }
    console.log(`Seeded demo document ${doc.invoice_number}.`);
  }
}

async function resetDemoDocumentData() {
  if (process.env.RESET_DEMO_DATA !== "1") {
    throw new Error("Refusing to reset demo data. Set RESET_DEMO_DATA=1 to confirm document reset.");
  }

  const url = new URL(SUPABASE_URL);
  const docsResult = await supabase.from("documents").select("id");
  if (docsResult.error) throw docsResult.error;
  const historyResult = await supabase.from("approval_history").select("id");
  if (historyResult.error) throw historyResult.error;

  const nil = "00000000-0000-0000-0000-000000000000";
  const deleteHistory = await supabase.from("approval_history").delete().neq("id", nil);
  if (deleteHistory.error) throw deleteHistory.error;
  const deleteDocs = await supabase.from("documents").delete().neq("id", nil);
  if (deleteDocs.error) throw deleteDocs.error;

  console.log(`Reset target: ${url.hostname}`);
  console.log(`Removed ${docsResult.data.length} document record(s) and ${historyResult.data.length} approval history record(s).`);
}

(async () => {
  const resetDocs = process.argv.includes("--reset-demo-docs");
  const seedDocs = resetDocs || process.argv.includes("--with-docs");
  const users = await upsertDemoUsers();
  if (resetDocs) {
    await resetDemoDocumentData();
  }
  if (seedDocs) {
    await seedDemoDocuments(users.admin, users);
  }
  console.log("Supabase seed complete.");
})().catch((err) => {
  console.error("Supabase seed failed:", err.message);
  process.exit(1);
});
