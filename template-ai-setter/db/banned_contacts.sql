-- ============================================================================
-- banned_contacts — the manual ban list ("make this person not exist")
-- ----------------------------------------------------------------------------
-- Applied to your Supabase project on 2026-06-08.
-- Kept here for traceability since the schema otherwise lives only in Supabase.
--
-- A row means a contact Maher has explicitly banned. The Telegram side
-- (telegram_bot/setter_control.py ban_lead) writes the row, deletes the GHL
-- contact, and purges the lead. The webhook (src/app/api/webhook/ghl/route.ts,
-- via src/lib/bans.ts findActiveBan) checks every inbound and, on a match,
-- deletes the GHL contact GHL re-creates and refuses to engage.
--
-- Durable identity: GHL mints a NEW ghl_contact_id when a deleted contact DMs
-- again, so ig_username (normalized: lowercase, no leading '@') is the key that
-- survives. We match on ghl_contact_id OR ig_username OR ig_sender_id.
--
-- Unbanning sets active=false (the row is kept as history); a later DM is then
-- treated as a brand-new lead.
-- ============================================================================

create table if not exists public.banned_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  ghl_contact_id text,
  ig_username text,            -- normalized: lowercase, no leading '@'
  ig_sender_id text,
  full_name text,
  reason text,
  banned_by text default 'telegram',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unbanned_at timestamptz
);

create index if not exists banned_contacts_client_active_idx
  on public.banned_contacts (client_id, active);
create index if not exists banned_contacts_ghl_contact_idx
  on public.banned_contacts (ghl_contact_id) where ghl_contact_id is not null;
create index if not exists banned_contacts_ig_username_idx
  on public.banned_contacts (ig_username) where ig_username is not null;
create index if not exists banned_contacts_ig_sender_idx
  on public.banned_contacts (ig_sender_id) where ig_sender_id is not null;

-- Match the security posture of clients/leads/etc: RLS on, no policies. The
-- backend uses the service-role key (bypasses RLS); the anon key gets nothing.
alter table public.banned_contacts enable row level security;
