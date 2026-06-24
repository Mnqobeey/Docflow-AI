create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  display_name text,
  role text not null check (role in ('admin', 'approver', 'viewer')),
  approval_step integer null check (approval_step is null or approval_step between 1 and 3),
  step_label text null,
  created_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  document_type text not null check (document_type in ('invoice', 'credit_note')),
  vendor text not null,
  invoice_number text not null,
  invoice_date date null,
  amount numeric(14, 2) not null,
  vat numeric(14, 2) not null default 0,
  status text not null default 'pending_approval_1'
    check (status in ('pending_approval_1', 'pending_approval_2', 'pending_approval_3', 'approved', 'rejected')),
  current_step integer null default 1 check (current_step is null or current_step between 1 and 3),
  file_name text,
  file_type text,
  file_hash text,
  duplicate_status text null,
  duplicate_reason text null,
  extraction_method text null,
  extraction_confidence numeric(5, 4) null,
  extraction_notes text null,
  uploaded_by uuid null references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.approval_history (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  stage integer not null check (stage between 1 and 3),
  role text not null,
  action text not null check (action in ('approve', 'reject')),
  user_id uuid null references public.users(id) on delete set null,
  comment text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_docflow_users_username on public.users (username);
create index if not exists idx_docflow_documents_invoice_number on public.documents (invoice_number);
create index if not exists idx_docflow_documents_vendor_amount on public.documents (vendor, amount);
create index if not exists idx_docflow_documents_file_hash on public.documents (file_hash);
create index if not exists idx_docflow_documents_status on public.documents (status);
create index if not exists idx_docflow_documents_created_at on public.documents (created_at);
create index if not exists idx_docflow_approval_history_document on public.approval_history (document_id, created_at);

create or replace function public.set_docflow_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_docflow_documents_updated_at on public.documents;
create trigger set_docflow_documents_updated_at
before update on public.documents
for each row
execute function public.set_docflow_updated_at();

alter table public.users enable row level security;
alter table public.documents enable row level security;
alter table public.approval_history enable row level security;
