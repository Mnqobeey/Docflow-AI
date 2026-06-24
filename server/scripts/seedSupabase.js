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

const DEMO_DOCS = [
  {
    document_type: "invoice",
    vendor: "Takealot Online (Pty) Ltd",
    invoice_number: "TAK-2024-0341",
    invoice_date: "2024-11-15",
    amount: 12540,
    vat: 1632.17,
    file_name: "takealot-inv-0341.pdf",
  },
  {
    document_type: "invoice",
    vendor: "MTN South Africa",
    invoice_number: "MTN-INV-98234",
    invoice_date: "2024-11-28",
    amount: 3899,
    vat: 507.52,
    file_name: "mtn-invoice-nov24.pdf",
  },
  {
    document_type: "credit_note",
    vendor: "Makro Retail (Pty) Ltd",
    invoice_number: "CN-MAKRO-0021",
    invoice_date: "2024-12-03",
    amount: 7200,
    vat: 937.24,
    file_name: "makro-cn0021.pdf",
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

async function seedDemoDocuments(adminId) {
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

    const { error } = await supabase.from("documents").insert({
      ...doc,
      status: "pending_approval_1",
      current_step: 1,
      file_type: "application/pdf",
      file_hash: `seed-${doc.invoice_number.toLowerCase()}`,
      extraction_method: "seeded_demo",
      extraction_confidence: 1,
      extraction_notes: "Seeded demo document for recruiter testing.",
      uploaded_by: adminId,
    });
    if (error) throw error;
    console.log(`Seeded demo document ${doc.invoice_number}.`);
  }
}

(async () => {
  const users = await upsertDemoUsers();
  if (process.argv.includes("--with-docs")) {
    await seedDemoDocuments(users.admin);
  }
  console.log("Supabase seed complete.");
})().catch((err) => {
  console.error("Supabase seed failed:", err.message);
  process.exit(1);
});
