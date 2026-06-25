-- ============================================================================
-- Review request engine (see lib/reviews.ts). Applied to the ai-setter
-- Supabase project. Kept here for version control.
-- ============================================================================
--
-- New clients columns: a kill switch (off by default) and the link sent in
-- the review-request DM. The engine never fires for a client until both are
-- set.
alter table public.clients
  add column if not exists reviews_enabled boolean not null default false;

alter table public.clients
  add column if not exists review_link text;

-- review_requests mirrors job_reminders' shape exactly (see funnel_stage_split
-- migration / schema.sql for job_reminders) — one row per scheduled/sent
-- review-request DM, unique per (lead, appointment time) so a rescheduled job
-- gets a fresh request while an unchanged one is never double-booked.
create table if not exists public.review_requests (
    id uuid not null default gen_random_uuid(),
    client_id uuid not null,
    lead_id uuid not null,
    ghl_contact_id text,
    channel text not null default 'IG'::text,
    appt_at timestamp with time zone not null,
    run_at timestamp with time zone not null,
    status text not null default 'pending'::text,
    attempts integer not null default 0,
    meta jsonb not null default '{}'::jsonb,
    created_at timestamp with time zone not null default now(),
    sent_at timestamp with time zone
);

do $$ begin
    alter table public.review_requests add constraint review_requests_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;

do $$ begin
    alter table public.review_requests add constraint review_requests_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;

do $$ begin
    alter table public.review_requests add constraint review_requests_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;

create unique index if not exists review_requests_lead_appt_uniq on public.review_requests using btree (lead_id, appt_at);
create index if not exists review_requests_due_idx on public.review_requests using btree (status, run_at);
create index if not exists review_requests_client_idx on public.review_requests using btree (client_id);

-- Turn it on for taxableai with a placeholder review link — swap in the real
-- Google/Trustpilot link before this actually goes live.
update public.clients
set reviews_enabled = true,
    review_link = 'https://g.page/r/REPLACE_ME/review'
where slug = 'taxableai';
