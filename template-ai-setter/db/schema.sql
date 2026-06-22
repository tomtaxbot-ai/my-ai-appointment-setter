-- =====================================================================
-- AI Setter — Full Public Schema (Resale Template)
-- =====================================================================
-- This file recreates the ENTIRE Supabase Postgres `public` schema from
-- scratch: extensions, tables, constraints, indexes, views, functions
-- and triggers. It contains SCHEMA ONLY — no rows, no real data, no
-- secrets.
--
-- HOW TO USE:
--   Run once on a fresh Supabase project (SQL editor) to build the whole
--   database. Schema only — no data.
--
-- The script is idempotent where practical (IF NOT EXISTS / OR REPLACE /
-- guarded DO blocks) so it is safe to re-run.
--
-- Order is dependency-safe:
--   1. Extensions
--   2. Custom types / enums (none in this schema)
--   3. Tables
--   4. Primary key / unique / check constraints
--   5. Foreign keys
--   6. Indexes
--   7. Views (dependency-ordered)
--   8. Functions / RPCs
--   9. Triggers
-- =====================================================================


-- =====================================================================
-- 1. EXTENSIONS
-- =====================================================================
-- pgcrypto provides gen_random_uuid() used as the default for most PKs.
-- On Supabase pgcrypto + uuid-ossp live in the `extensions` schema; we
-- mirror that here. `vector` (pgvector) lives in `public` on the source
-- project and brings ~118 helper functions with it (l2_distance,
-- array_to_vector, hnswhandler, etc.) — those are created automatically
-- by this single statement, so they are NOT redeclared below.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists pg_net with schema public;


-- =====================================================================
-- 2. CUSTOM TYPES / ENUMS
-- =====================================================================
-- No user-defined enum types exist in the public schema.


-- =====================================================================
-- 3. TABLES
-- =====================================================================

create table if not exists public.ai_decisions (
    id uuid not null default gen_random_uuid(),
    lead_id uuid not null,
    client_id uuid not null,
    message_id uuid,
    system_prompt_used text not null,
    conversation_context jsonb not null,
    raw_response text not null,
    final_reply text,
    duration_ms integer,
    error text,
    created_at timestamp with time zone not null default now()
);

create table if not exists public.banned_contacts (
    id uuid not null default gen_random_uuid(),
    client_id uuid not null,
    ghl_contact_id text,
    ig_username text,
    ig_sender_id text,
    full_name text,
    reason text,
    banned_by text default 'telegram'::text,
    active boolean not null default true,
    created_at timestamp with time zone not null default now(),
    unbanned_at timestamp with time zone
);

create table if not exists public.call_outcomes (
    id uuid not null default gen_random_uuid(),
    client_id uuid,
    lead_id uuid,
    ghl_contact_id text,
    showed boolean not null default false,
    pitched boolean not null default false,
    closed boolean not null default false,
    outcome text not null,
    customer_id uuid,
    logged_by text,
    note text,
    created_at timestamp with time zone default now(),
    reason text,
    call_duration_minutes integer
);

create table if not exists public.call_reminders (
    ghl_appointment_id text not null,
    lead_id uuid,
    ghl_contact_id text,
    call_at timestamp with time zone,
    reminded_at timestamp with time zone default now()
);

create table if not exists public.clients (
    id uuid not null default gen_random_uuid(),
    name text not null,
    slug text not null,
    ghl_location_id text,
    ghl_api_key text,
    system_prompt text not null default ''::text,
    voice_samples text not null default ''::text,
    active_rules text not null default ''::text,
    business_context text not null default ''::text,
    is_active boolean not null default true,
    timezone text not null default 'UTC'::text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    stages jsonb not null default '[]'::jsonb,
    ghl_calendar_id text,
    reply_delay_min_seconds integer,
    reply_delay_max_seconds integer,
    setter_resume_at timestamp with time zone,
    nurture_enabled boolean not null default false,
    nurture_enabled_at timestamp with time zone,
    followup_enabled boolean not null default false,
    followup_enabled_at timestamp with time zone,
    dm_intel_enabled boolean not null default false,
    pain_dig_enabled boolean not null default false,
    pain_protocol text,
    voice_enabled boolean not null default false,
    setter_voice_id text,
    setter_voice_id_sv text,
    whale_radar_enabled boolean not null default false
);

create table if not exists public.content_pipeline (
    id uuid not null default gen_random_uuid(),
    title text not null,
    idea text,
    angle text,
    status text not null default 'backlog'::text,
    source text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    funnel text not null default 'youtube'::text,
    "position" double precision not null default 0,
    make_status text,
    make_requested_at timestamp with time zone,
    make_error text,
    script_url text,
    doc_url text,
    youtube_url text,
    perf_views bigint,
    perf_retention double precision,
    perf_cash double precision,
    perf_updated_at timestamp with time zone
);

create table if not exists public.customers (
    id uuid not null default gen_random_uuid(),
    client_id uuid,
    name text not null,
    lead_id uuid,
    ghl_contact_id text,
    created_at timestamp with time zone not null default now(),
    contract_value numeric,
    currency text default 'USD'::text,
    closer text,
    closed_at timestamp with time zone,
    status text default 'active'::text,
    note text,
    source text,
    campaign text,
    placement text,
    booking_method text
);

create table if not exists public.dashboard_config (
    id integer not null default 1,
    password text not null,
    updated_at timestamp with time zone not null default now()
);

create table if not exists public.disputes (
    id uuid not null default gen_random_uuid(),
    lead_id uuid,
    customer_id uuid,
    ghl_contact_id text,
    amount numeric not null default 0,
    status text not null default 'open'::text,
    reason text,
    opened_at timestamp with time zone default now(),
    resolved_at timestamp with time zone,
    logged_by text,
    created_at timestamp with time zone default now()
);

create table if not exists public.dm_intel_reports (
    id uuid not null default gen_random_uuid(),
    client_id uuid not null,
    trigger text not null default 'manual'::text,
    summary text,
    findings jsonb not null default '[]'::jsonb,
    sample jsonb not null default '{}'::jsonb,
    created_at timestamp with time zone not null default now(),
    method text
);

create table if not exists public.dm_suggestions (
    id uuid not null default gen_random_uuid(),
    report_id uuid not null,
    client_id uuid not null,
    title text not null,
    finding text,
    evidence text,
    proposed_change text,
    target text,
    confidence text,
    status text not null default 'pending'::text,
    created_at timestamp with time zone not null default now(),
    why_best text,
    expected_impact text
);

create table if not exists public.events (
    id uuid not null default gen_random_uuid(),
    client_id uuid not null,
    lead_id uuid,
    event_type text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamp with time zone not null default now()
);

create table if not exists public.follow_up_log (
    id uuid not null default gen_random_uuid(),
    client_id uuid not null,
    lead_id uuid not null,
    ghl_contact_id text,
    bucket text not null,
    attempt integer not null,
    anchor timestamp with time zone not null,
    stage_at_stall text,
    status text not null default 'sending'::text,
    message text,
    ghl_message_id text,
    sent_at timestamp with time zone default now(),
    revived_at timestamp with time zone,
    recovered_at timestamp with time zone,
    created_at timestamp with time zone not null default now()
);

create table if not exists public.follower_counts (
    id uuid not null default gen_random_uuid(),
    week_start date not null,
    followers_gained integer,
    recorded_at timestamp with time zone default now(),
    recorded_by text
);

create table if not exists public.leads (
    id uuid not null default gen_random_uuid(),
    client_id uuid not null,
    ghl_contact_id text,
    ig_username text,
    full_name text,
    phone text,
    email text,
    status text not null default 'new'::text,
    first_contact_at timestamp with time zone not null default now(),
    last_message_at timestamp with time zone not null default now(),
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    ai_paused boolean not null default false,
    screened boolean not null default false,
    stage text,
    stage_data jsonb not null default '{}'::jsonb,
    ghl_opportunity_id text,
    source text,
    campaign text,
    source_enriched text,
    source_method text,
    campaign_enriched text,
    attribution_raw jsonb,
    enriched_at timestamp with time zone,
    conversation_language text,
    deal_value numeric,
    src_channel text,
    src_placement text,
    src_campaign text,
    src_content text,
    booking_method text,
    ai_booked boolean,
    ai_message_share numeric,
    disqualify_reason text,
    opted_in boolean,
    funnel_stage text,
    reply_lock_at timestamp with time zone,
    nurture_paused boolean not null default false,
    followup_paused boolean not null default false,
    voice_paused boolean not null default false,
    whale_paused boolean not null default false
);

create table if not exists public.messages (
    id uuid not null default gen_random_uuid(),
    lead_id uuid not null,
    client_id uuid not null,
    role text not null,
    content text not null,
    channel text not null default 'instagram'::text,
    ghl_message_id text,
    model_used text,
    input_tokens integer,
    output_tokens integer,
    created_at timestamp with time zone not null default now()
);

create table if not exists public.notes (
    id uuid not null default gen_random_uuid(),
    client_id uuid,
    content text not null,
    created_by text,
    created_at timestamp with time zone default now()
);

create table if not exists public.nurture_jobs (
    id uuid not null default gen_random_uuid(),
    client_id uuid not null,
    lead_id uuid not null,
    ghl_contact_id text,
    channel text not null default 'IG'::text,
    kind text not null,
    run_at timestamp with time zone not null,
    status text not null default 'pending'::text,
    attempts integer not null default 0,
    meta jsonb not null default '{}'::jsonb,
    created_at timestamp with time zone not null default now(),
    sent_at timestamp with time zone
);

create table if not exists public.payments (
    id uuid not null default gen_random_uuid(),
    client_id uuid,
    customer_id uuid,
    lead_id uuid,
    ghl_contact_id text,
    amount numeric not null,
    currency text default 'USD'::text,
    kind text default 'payment'::text,
    collected_at timestamp with time zone default now(),
    logged_by text,
    note text,
    created_at timestamp with time zone default now()
);

create table if not exists public.pipeline_stages (
    id uuid not null default gen_random_uuid(),
    funnel text not null,
    key text not null,
    label text not null,
    "position" double precision not null default 0,
    created_at timestamp with time zone not null default now()
);

create table if not exists public.prompter_config (
    id integer not null default 1,
    access_key text not null,
    created_at timestamp with time zone not null default now()
);

create table if not exists public.scheduled_payments (
    id uuid not null default gen_random_uuid(),
    client_id uuid,
    customer_id uuid,
    amount numeric not null,
    currency text default 'USD'::text,
    due_date date not null,
    status text not null default 'pending'::text,
    note text,
    created_by text,
    created_at timestamp with time zone not null default now(),
    reminded_at timestamp with time zone,
    payment_id uuid
);

create table if not exists public.setter_brain_versions (
    id uuid not null default gen_random_uuid(),
    client_id uuid,
    field text not null,
    old_value text,
    new_value text,
    changed_by text,
    changed_at timestamp with time zone default now()
);

create table if not exists public.team_activity (
    id uuid not null default gen_random_uuid(),
    client_id uuid,
    team_member_id uuid,
    activity_date date not null default CURRENT_DATE,
    outreaches integer default 0,
    dials integer default 0,
    conversations integer default 0,
    note text,
    logged_by text,
    created_at timestamp with time zone default now(),
    followups_outreach integer default 0,
    pickups integer default 0,
    followups_dials integer default 0
);

create table if not exists public.team_members (
    id uuid not null default gen_random_uuid(),
    client_id uuid,
    name text not null,
    role text not null default 'closer'::text,
    telegram_chat_id text,
    active boolean not null default true,
    created_at timestamp with time zone not null default now(),
    registration_code text,
    registered_at timestamp with time zone,
    reminder_enabled boolean default true,
    reminder_hour integer default 19,
    reminder_minute integer default 0,
    reminder_tz text default 'Europe/Stockholm'::text,
    last_reminder_date date,
    ghl_user_id text
);

create table if not exists public.webhook_debug_logs (
    id uuid not null default gen_random_uuid(),
    created_at timestamp with time zone default now(),
    raw_payload jsonb,
    raw_headers jsonb,
    extracted_data jsonb,
    parse_result text
);

create table if not exists public.yt_scripts (
    id uuid not null default gen_random_uuid(),
    title text not null default ''::text,
    modules jsonb not null default '[]'::jsonb,
    full_package text not null default ''::text,
    created_at timestamp with time zone not null default now()
);


-- =====================================================================
-- 4. PRIMARY KEY / UNIQUE / CHECK CONSTRAINTS
-- =====================================================================
-- Guarded with DO blocks so re-running does not error on existing
-- constraints (ADD CONSTRAINT has no IF NOT EXISTS).

do $$ begin
    -- CHECK constraints
    alter table public.content_pipeline add constraint content_pipeline_status_check CHECK ((status = ANY (ARRAY['backlog'::text, 'chosen'::text, 'scripted'::text, 'filmed'::text, 'published'::text, 'archived'::text])));
exception when duplicate_object then null; end $$;

do $$ begin
    alter table public.dashboard_config add constraint dashboard_config_single_row CHECK ((id = 1));
exception when duplicate_object then null; end $$;

do $$ begin
    alter table public.prompter_config add constraint prompter_config_single_row CHECK ((id = 1));
exception when duplicate_object then null; end $$;

do $$ begin
    -- PRIMARY KEYs
    alter table public.ai_decisions add constraint ai_decisions_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.banned_contacts add constraint banned_contacts_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.call_outcomes add constraint call_outcomes_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.call_reminders add constraint call_reminders_pkey PRIMARY KEY (ghl_appointment_id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.clients add constraint clients_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.content_pipeline add constraint content_pipeline_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.customers add constraint customers_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.dashboard_config add constraint dashboard_config_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.disputes add constraint disputes_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.dm_intel_reports add constraint dm_intel_reports_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.dm_suggestions add constraint dm_suggestions_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.events add constraint events_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.follow_up_log add constraint follow_up_log_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.follower_counts add constraint follower_counts_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.leads add constraint leads_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.messages add constraint messages_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.notes add constraint notes_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.nurture_jobs add constraint nurture_jobs_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.payments add constraint payments_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.pipeline_stages add constraint pipeline_stages_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.prompter_config add constraint prompter_config_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.scheduled_payments add constraint scheduled_payments_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.setter_brain_versions add constraint setter_brain_versions_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.team_activity add constraint team_activity_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.team_members add constraint team_members_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.webhook_debug_logs add constraint webhook_debug_logs_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.yt_scripts add constraint yt_scripts_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;

do $$ begin
    -- UNIQUE constraints
    alter table public.clients add constraint clients_slug_key UNIQUE (slug);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.follower_counts add constraint follower_counts_week_start_key UNIQUE (week_start);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.leads add constraint leads_client_id_ghl_contact_id_key UNIQUE (client_id, ghl_contact_id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.pipeline_stages add constraint pipeline_stages_funnel_key_key UNIQUE (funnel, key);
exception when duplicate_object then null; end $$;


-- =====================================================================
-- 5. FOREIGN KEYS
-- =====================================================================

do $$ begin
    alter table public.ai_decisions add constraint ai_decisions_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.ai_decisions add constraint ai_decisions_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.ai_decisions add constraint ai_decisions_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.banned_contacts add constraint banned_contacts_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.call_outcomes add constraint call_outcomes_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.call_outcomes add constraint call_outcomes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.call_outcomes add constraint call_outcomes_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.call_reminders add constraint call_reminders_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.customers add constraint customers_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.customers add constraint customers_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.disputes add constraint disputes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.disputes add constraint disputes_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.events add constraint events_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.events add constraint events_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.leads add constraint leads_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.messages add constraint messages_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.messages add constraint messages_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.notes add constraint notes_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.payments add constraint payments_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.scheduled_payments add constraint scheduled_payments_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.setter_brain_versions add constraint setter_brain_versions_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.team_activity add constraint team_activity_team_member_id_fkey FOREIGN KEY (team_member_id) REFERENCES team_members(id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.team_members add constraint team_members_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
exception when duplicate_object then null; end $$;


-- =====================================================================
-- 6. INDEXES
-- =====================================================================
-- Excludes indexes that back PK / UNIQUE constraints (created in step 4).
-- Two standalone UNIQUE indexes are included here as they are not tied
-- to a named table constraint.

create index if not exists idx_decisions_client on public.ai_decisions using btree (client_id, created_at DESC);
create index if not exists idx_decisions_lead on public.ai_decisions using btree (lead_id, created_at DESC);
create index if not exists banned_contacts_client_active_idx on public.banned_contacts using btree (client_id, active);
create index if not exists banned_contacts_ghl_contact_idx on public.banned_contacts using btree (ghl_contact_id) where (ghl_contact_id is not null);
create index if not exists banned_contacts_ig_sender_idx on public.banned_contacts using btree (ig_sender_id) where (ig_sender_id is not null);
create index if not exists banned_contacts_ig_username_idx on public.banned_contacts using btree (ig_username) where (ig_username is not null);
create index if not exists content_pipeline_created_at_idx on public.content_pipeline using btree (created_at DESC);
create index if not exists content_pipeline_funnel_idx on public.content_pipeline using btree (funnel);
create index if not exists content_pipeline_make_status_idx on public.content_pipeline using btree (make_status) where (make_status is not null);
create index if not exists content_pipeline_status_idx on public.content_pipeline using btree (status);
create index if not exists dm_reports_client_idx on public.dm_intel_reports using btree (client_id, created_at DESC);
create index if not exists dm_suggestions_report_idx on public.dm_suggestions using btree (report_id);
create index if not exists idx_events_client_time on public.events using btree (client_id, created_at DESC);
create index if not exists idx_events_type on public.events using btree (event_type);
create unique index if not exists follow_up_log_lead_anchor_attempt_uniq on public.follow_up_log using btree (lead_id, anchor, attempt);
create index if not exists follow_up_log_lead_idx on public.follow_up_log using btree (lead_id);
create index if not exists follow_up_log_sent_idx on public.follow_up_log using btree (sent_at);
create index if not exists idx_leads_client on public.leads using btree (client_id);
create index if not exists idx_leads_ghl on public.leads using btree (ghl_contact_id);
create index if not exists idx_leads_status on public.leads using btree (status);
create index if not exists idx_messages_client on public.messages using btree (client_id, created_at);
create index if not exists idx_messages_lead on public.messages using btree (lead_id, created_at);
create index if not exists nurture_jobs_due_idx on public.nurture_jobs using btree (status, run_at);
create unique index if not exists nurture_jobs_lead_kind_uniq on public.nurture_jobs using btree (lead_id, kind);
create index if not exists pipeline_stages_funnel_idx on public.pipeline_stages using btree (funnel, "position");
create index if not exists scheduled_payments_due_idx on public.scheduled_payments using btree (status, due_date);
create index if not exists idx_webhook_debug_logs_created_at on public.webhook_debug_logs using btree (created_at DESC);
create index if not exists yt_scripts_created_at_idx on public.yt_scripts using btree (created_at DESC);


-- =====================================================================
-- 7. VIEWS
-- =====================================================================
-- Emitted in dependency order:
--   reporting_leads  -> reporting_funnel  (funnel selects from leads view)
--   reporting_money  -> reporting_money_summary
-- Independent views are emitted first.

create or replace view public.reporting_calls as
 SELECT co.id,
    co.lead_id,
    co.created_at,
    co.created_at::date AS call_date,
    co.showed,
    co.pitched,
    co.closed,
    co.outcome,
    co.reason,
    co.call_duration_minutes,
    co.customer_id,
    l.full_name,
    COALESCE(NULLIF(l.source_enriched, ''::text), l.source) AS effective_source
   FROM call_outcomes co
     LEFT JOIN leads l ON l.id = co.lead_id;

create or replace view public.reporting_followups as
 SELECT ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'follow_up_sent'::text) AS sent_total,
    ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'follow_up_sent'::text AND events.created_at > (now() - '7 days'::interval)) AS sent_7d,
    ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'follow_up_sent'::text AND events.created_at > (now() - '30 days'::interval)) AS sent_30d,
    ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'lead_revived'::text) AS revived_total,
    ( SELECT count(*) AS count
           FROM events
          WHERE events.event_type = 'lead_revived'::text AND events.created_at > (now() - '7 days'::interval)) AS revived_7d,
    ( SELECT count(DISTINCT r.lead_id) AS count
           FROM events r
          WHERE r.event_type = 'lead_revived'::text AND (EXISTS ( SELECT 1
                   FROM events b
                  WHERE b.lead_id = r.lead_id AND b.event_type = 'appointment_booked'::text AND b.created_at > r.created_at))) AS rebooked_total;

create or replace view public.reporting_lead_timing as
 WITH created AS (
         SELECT events.lead_id,
            min(events.created_at) AS lead_created_at
           FROM events
          WHERE events.event_type = 'lead_created'::text
          GROUP BY events.lead_id
        ), msgs AS (
         SELECT events.lead_id,
            min(events.created_at) AS first_lead_msg_at
           FROM events
          WHERE events.event_type = 'lead_message_received'::text
          GROUP BY events.lead_id
        ), replies AS (
         SELECT events.lead_id,
            min(events.created_at) AS first_ai_reply_at
           FROM events
          WHERE events.event_type = 'ai_replied'::text
          GROUP BY events.lead_id
        ), booked AS (
         SELECT events.lead_id,
            min(events.created_at) AS booked_at
           FROM events
          WHERE events.event_type = ANY (ARRAY['call_booked'::text, 'appointment_booked'::text])
          GROUP BY events.lead_id
        )
 SELECT l.id AS lead_id,
    l.full_name,
    COALESCE(NULLIF(l.source_enriched, ''::text), l.source) AS effective_source,
    c.lead_created_at,
    m.first_lead_msg_at,
    r.first_ai_reply_at,
        CASE
            WHEN r.first_ai_reply_at IS NOT NULL AND m.first_lead_msg_at IS NOT NULL AND r.first_ai_reply_at >= m.first_lead_msg_at THEN EXTRACT(epoch FROM r.first_ai_reply_at - m.first_lead_msg_at)
            ELSE NULL::numeric
        END AS first_reply_seconds,
    b.booked_at,
        CASE
            WHEN b.booked_at IS NOT NULL AND c.lead_created_at IS NOT NULL AND b.booked_at >= c.lead_created_at THEN round(EXTRACT(epoch FROM b.booked_at - c.lead_created_at) / 86400.0, 2)
            ELSE NULL::numeric
        END AS days_lead_to_booked
   FROM leads l
     LEFT JOIN created c ON c.lead_id = l.id
     LEFT JOIN msgs m ON m.lead_id = l.id
     LEFT JOIN replies r ON r.lead_id = l.id
     LEFT JOIN booked b ON b.lead_id = l.id;

create or replace view public.reporting_leak_map as
 SELECT funnel_stage,
    count(*)::integer AS stalled
   FROM leads
  WHERE status = 'engaged'::text AND funnel_stage IS NOT NULL AND last_message_at < (now() - '24:00:00'::interval)
  GROUP BY funnel_stage;

create or replace view public.reporting_leads as
 WITH lead_dates AS (
         SELECT events.lead_id,
            min(events.created_at) AS lead_date
           FROM events
          WHERE events.event_type = 'lead_created'::text
          GROUP BY events.lead_id
        ), booked_events AS (
         SELECT DISTINCT events.lead_id
           FROM events
          WHERE events.event_type = ANY (ARRAY['call_booked'::text, 'appointment_booked'::text])
        ), junk_flags AS (
         SELECT DISTINCT events.lead_id
           FROM events
          WHERE events.event_type = ANY (ARRAY['screen_skip_owner'::text, 'screen_skip_friend'::text, 'handoff_biz_owner'::text])
        ), test_flags AS (
         SELECT l_1.id,
            l_1.full_name ~~* '%test%'::text OR l_1.full_name ~~* '%demo%'::text OR l_1.full_name ~~* 'qa-%'::text OR COALESCE(NULLIF(l_1.source_enriched, ''::text), l_1.source) ~~* 'qa-%'::text OR COALESCE(NULLIF(l_1.source_enriched, ''::text), l_1.source) = 'aima'::text AS is_test
           FROM leads l_1
        )
 SELECT l.id,
    l.client_id,
    l.full_name,
    l.stage,
    l.deal_value,
    COALESCE(NULLIF(l.source_enriched, ''::text), l.source) AS effective_source,
    COALESCE(NULLIF(l.campaign_enriched, ''::text), l.campaign) AS effective_campaign,
    COALESCE(ld.lead_date, l.created_at) AS lead_date,
    tf.is_test,
    jf.lead_id IS NOT NULL AS is_screener_junk,
    NOT tf.is_test AND jf.lead_id IS NULL AS is_real_prospect,
    l.stage = ANY (ARRAY['Call Pitched'::text, 'Appointment Booked'::text, 'Contacted'::text, 'Appointment Confirmed'::text, 'No Show - Re-Nurture'::text, 'Client Won'::text]) AS reached_pitched,
    (l.stage = ANY (ARRAY['Appointment Booked'::text, 'Contacted'::text, 'Appointment Confirmed'::text, 'No Show - Re-Nurture'::text, 'Client Won'::text])) OR be.lead_id IS NOT NULL AS reached_booked,
    l.stage = 'No Show - Re-Nurture'::text AS is_no_show,
    l.stage = 'Client Won'::text AS is_won,
    l.stage = 'Lead Lost'::text AS is_lost,
    l.stage = 'Disqualified'::text AS is_disqualified
   FROM leads l
     LEFT JOIN lead_dates ld ON ld.lead_id = l.id
     LEFT JOIN booked_events be ON be.lead_id = l.id
     LEFT JOIN junk_flags jf ON jf.lead_id = l.id
     LEFT JOIN test_flags tf ON tf.id = l.id;

create or replace view public.reporting_funnel as
 WITH marked AS (
         SELECT messages.lead_id,
            messages.role,
            messages.created_at,
                CASE
                    WHEN messages.role IS DISTINCT FROM lag(messages.role) OVER (PARTITION BY messages.lead_id ORDER BY messages.created_at) THEN 1
                    ELSE 0
                END AS new_turn
           FROM messages
          WHERE messages.role = ANY (ARRAY['ai'::text, 'human'::text, 'lead'::text])
        ), grouped AS (
         SELECT marked.lead_id,
            marked.role,
            marked.created_at,
            sum(marked.new_turn) OVER (PARTITION BY marked.lead_id ORDER BY marked.created_at) AS turn_id
           FROM marked
        ), turns AS (
         SELECT grouped.lead_id,
            grouped.turn_id,
            max(grouped.role) AS role,
            min(grouped.created_at) AS turn_start
           FROM grouped
          GROUP BY grouped.lead_id, grouped.turn_id
        ), turn_seq AS (
         SELECT turns.lead_id,
            turns.role,
            lag(turns.role) OVER (PARTITION BY turns.lead_id ORDER BY turns.turn_start) AS prev_role
           FROM turns
        ), fu AS (
         SELECT turn_seq.lead_id,
            count(*) AS cnt
           FROM turn_seq
          WHERE (turn_seq.role = ANY (ARRAY['ai'::text, 'human'::text])) AND (turn_seq.prev_role = ANY (ARRAY['ai'::text, 'human'::text]))
          GROUP BY turn_seq.lead_id
        ), ash AS (
         SELECT turns.lead_id,
            count(*) FILTER (WHERE turns.role = 'ai'::text)::numeric / NULLIF(count(*) FILTER (WHERE turns.role = ANY (ARRAY['ai'::text, 'human'::text])), 0)::numeric AS share
           FROM turns
          GROUP BY turns.lead_id
        ), replied AS (
         SELECT DISTINCT messages.lead_id
           FROM messages
          WHERE messages.role = 'lead'::text
        ), icp AS (
         SELECT DISTINCT events.lead_id
           FROM events
          WHERE events.event_type = 'tag_icp'::text
        ), qual AS (
         SELECT DISTINCT events.lead_id
           FROM events
          WHERE events.event_type = 'tag_qualified'::text
        )
 SELECT rl.id,
    rl.lead_date,
    rl.reached_pitched,
    rl.reached_booked,
    rl.is_won,
    rl.is_lost,
    rl.is_no_show,
    rl.effective_source,
        CASE lower(COALESCE(l.src_channel, rl.effective_source))
            WHEN 'instagram'::text THEN 'IG'::text
            WHEN 'ig'::text THEN 'IG'::text
            WHEN 'youtube'::text THEN 'YouTube'::text
            WHEN 'yt'::text THEN 'YouTube'::text
            WHEN 'tiktok'::text THEN 'TikTok'::text
            WHEN 'referral'::text THEN 'Referrals'::text
            WHEN 'referrals'::text THEN 'Referrals'::text
            WHEN 'affiliate'::text THEN 'Affiliates'::text
            WHEN 'affiliates'::text THEN 'Affiliates'::text
            WHEN 'ads'::text THEN 'Ads'::text
            WHEN 'paid'::text THEN 'Ads'::text
            WHEN 'linkedin'::text THEN 'LinkedIn'::text
            WHEN 'x'::text THEN 'X'::text
            WHEN 'twitter'::text THEN 'X'::text
            WHEN 'threads'::text THEN 'Threads'::text
            WHEN 'facebook'::text THEN 'Facebook'::text
            WHEN 'fb'::text THEN 'Facebook'::text
            WHEN 'warm outreach'::text THEN 'Warm outreach'::text
            WHEN 'warm'::text THEN 'Warm outreach'::text
            ELSE initcap(COALESCE(l.src_channel, rl.effective_source))
        END AS channel,
    l.src_placement,
    COALESCE(l.src_campaign, rl.effective_campaign) AS campaign,
    l.booking_method,
    COALESCE(ash.share, 0::numeric) >= 0.5 AS ai_booked,
    l.disqualify_reason,
    l.opted_in,
        CASE
            WHEN COALESCE(l.opted_in, false) THEN 'inbound'::text
            WHEN lower(COALESCE(l.src_channel, rl.effective_source)) = ANY (ARRAY['instagram'::text, 'ig'::text]) THEN 'outbound'::text
            ELSE 'inbound'::text
        END AS funnel,
    r.lead_id IS NOT NULL AS replied,
    i.lead_id IS NOT NULL AS is_icp,
    q.lead_id IS NOT NULL AS is_qualified,
    COALESCE(fu.cnt, 0::bigint) AS followups,
    round(COALESCE(ash.share, 0::numeric) * 100::numeric) AS ai_share_pct
   FROM reporting_leads rl
     JOIN leads l ON l.id = rl.id
     LEFT JOIN fu ON fu.lead_id = rl.id
     LEFT JOIN ash ON ash.lead_id = rl.id
     LEFT JOIN replied r ON r.lead_id = rl.id
     LEFT JOIN icp i ON i.lead_id = rl.id
     LEFT JOIN qual q ON q.lead_id = rl.id
  WHERE rl.is_real_prospect AND rl.lead_date::date >= '2026-06-12'::date;

create or replace view public.reporting_money as
 SELECT c.id AS customer_id,
    c.client_id,
    c.name,
    c.lead_id,
    c.contract_value,
    c.currency,
    c.closer,
    c.closed_at,
    c.status,
    COALESCE(p.total_collected, 0::numeric) AS cash_collected,
    COALESCE(p.payment_count, 0::bigint) AS payment_count,
        CASE
            WHEN c.contract_value IS NOT NULL THEN c.contract_value - COALESCE(p.total_collected, 0::numeric)
            ELSE NULL::numeric
        END AS outstanding
   FROM customers c
     LEFT JOIN ( SELECT payments.customer_id,
            sum(payments.amount) AS total_collected,
            count(*) AS payment_count
           FROM payments
          GROUP BY payments.customer_id) p ON p.customer_id = c.id;

create or replace view public.reporting_money_summary as
 SELECT count(*) AS customer_count,
    COALESCE(sum(contract_value), 0::numeric) AS business_contract_ltv,
    COALESCE(sum(cash_collected), 0::numeric) AS business_cash_ltv,
    COALESCE(sum(outstanding), 0::numeric) AS business_outstanding
   FROM reporting_money;


-- =====================================================================
-- 8. FUNCTIONS / RPCs
-- =====================================================================
-- Only user-defined functions are emitted here. The ~118 pgvector
-- helper functions are owned by the `vector` extension and are created
-- automatically by `create extension vector` in step 1.

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.run_reporting_query(q text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result jsonb;
begin
  perform set_config('transaction_read_only', 'on', true);
  perform set_config('statement_timeout', '15000', true);

  if q !~* '^\s*(select|with)\M' then
    raise exception 'REJECTED: only SELECT/WITH queries are allowed';
  end if;
  if q ~ ';' then
    raise exception 'REJECTED: semicolons / multiple statements are not allowed';
  end if;
  if q ~* '\m(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|call|do|vacuum|reindex|cluster|lock|listen|notify|prepare|deallocate|pg_sleep)\M' then
    raise exception 'REJECTED: write/DDL keywords are not allowed';
  end if;

  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) raw limit 500) t',
    q
  ) into result;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_dashboard(p_start date DEFAULT '2000-01-01'::date, p_end date DEFAULT '2999-12-31'::date, p_source text DEFAULT NULL::text, p_funnel text DEFAULT 'all'::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  with rfc as (
    select * from reporting_funnel
    where lead_date::date between p_start and p_end
      and (p_source is null or channel = p_source)
  ),
  ta as (
    select coalesce(sum(outreaches),0) as outreaches, coalesce(sum(dials),0) as dials,
      coalesce(sum(followups_outreach),0) as followups_outreach,
      coalesce(sum(followups_dials),0) as followups_dials,
      coalesce(sum(pickups),0) as pickups
    from team_activity where activity_date between p_start and p_end
  ),
  scalls as (
    select rc.* from reporting_calls rc
    left join reporting_funnel rf on rf.id = rc.lead_id
    where rc.call_date between p_start and p_end
      and (p_source is null or rc.effective_source = p_source)
      and (p_funnel = 'all' or rf.funnel = p_funnel)
  ),
  custf as (
    select c.id, c.contract_value, c.closed_at, rf.funnel,
      coalesce((select sum(amount) from payments p where p.customer_id=c.id),0) as cash
    from customers c
    left join leads l on l.id=c.lead_id
    left join reporting_funnel rf on rf.id=l.id
  ),
  ms as (select customer_count, business_contract_ltv, business_cash_ltv, business_outstanding from reporting_money_summary)
  select jsonb_build_object(
    'period', jsonb_build_object('start',p_start,'end',p_end,'source',coalesce(p_source,'All sources'),'funnel',p_funnel),
    'outbound', jsonb_build_object(
      'new_followers', (select coalesce(sum(followers_gained),0) from follower_counts where week_start between p_start and p_end),
      'outreaches', (select outreaches from ta),
      'followups_outreach', (select followups_outreach from ta),
      'replies', (select count(*) from rfc where funnel='outbound' and replied),
      'followups_convo', (select coalesce(sum(followups),0) from rfc where funnel='outbound' and replied and not is_qualified and not reached_pitched),
      'icp', (select count(*) from rfc where funnel='outbound' and is_icp),
      'qualified', (select count(*) from rfc where funnel='outbound' and is_qualified),
      'call_pitched', (select count(*) from rfc where funnel='outbound' and reached_pitched),
      'followups_pitched', (select coalesce(sum(followups),0) from rfc where funnel='outbound' and reached_pitched),
      'booked', (select count(*) from rfc where funnel='outbound' and reached_booked),
      'pickup_rate', (select case when (select outreaches from ta)>0 then round((select count(*) from rfc where funnel='outbound' and replied)::numeric/(select outreaches from ta)*100,1) end),
      'qualified_to_pitched', (select case when (select count(*) from rfc where funnel='outbound' and is_qualified)>0 then round((select count(*) from rfc where funnel='outbound' and reached_pitched)::numeric/(select count(*) from rfc where funnel='outbound' and is_qualified)*100,1) end),
      'pitched_to_booked', (select case when (select count(*) from rfc where funnel='outbound' and reached_pitched)>0 then round((select count(*) from rfc where funnel='outbound' and reached_booked)::numeric/(select count(*) from rfc where funnel='outbound' and reached_pitched)*100,1) end)
    ),
    'inbound', jsonb_build_object(
      'new_leads', (select count(*) from rfc where funnel='inbound'),
      'dials', (select dials from ta),
      'followups_dials', (select followups_dials from ta),
      'pickups', (select pickups from ta),
      'icp', (select count(*) from rfc where funnel='inbound' and is_icp),
      'qualified', (select count(*) from rfc where funnel='inbound' and is_qualified),
      'call_pitched', (select count(*) from rfc where funnel='inbound' and reached_pitched),
      'booked', (select count(*) from rfc where funnel='inbound' and reached_booked),
      'dial_coverage', (select case when (select count(*) from rfc where funnel='inbound')>0 then round((select dials from ta)::numeric/(select count(*) from rfc where funnel='inbound')*100,1) end),
      'pickup_connect_rate', (select case when (select dials from ta)>0 then round((select pickups from ta)::numeric/(select dials from ta)*100,1) end),
      'pitched_to_booked', (select case when (select count(*) from rfc where funnel='inbound' and reached_pitched)>0 then round((select count(*) from rfc where funnel='inbound' and reached_booked)::numeric/(select count(*) from rfc where funnel='inbound' and reached_pitched)*100,1) end)
    ),
    'sales', jsonb_build_object(
      'booked', (select count(*) from rfc where reached_booked and (p_funnel='all' or funnel=p_funnel)),
      'ai_booked', (select count(*) from rfc where reached_booked and ai_booked and (p_funnel='all' or funnel=p_funnel)),
      'ai_booked_pct', (select case when (select count(*) from rfc where reached_booked and (p_funnel='all' or funnel=p_funnel))>0 then round((select count(*) from rfc where reached_booked and ai_booked and (p_funnel='all' or funnel=p_funnel))::numeric/(select count(*) from rfc where reached_booked and (p_funnel='all' or funnel=p_funnel))*100,1) end),
      'showed', (select count(*) from scalls where showed),
      'offer_pitched', (select count(*) from scalls where pitched),
      'closed', (select count(*) from scalls where closed),
      'no_shows', (select count(*) from scalls where outcome='no_show'),
      'losts', (select count(*) from scalls where outcome='pitched_no_close'),
      'avg_call_minutes_on_close', (select round(avg(call_duration_minutes),1) from scalls where closed and call_duration_minutes is not null),
      'show_rate', (select case when (select count(*) from rfc where reached_booked and (p_funnel='all' or funnel=p_funnel))>0 then round((select count(*) from scalls where showed)::numeric/(select count(*) from rfc where reached_booked and (p_funnel='all' or funnel=p_funnel))*100,1) end),
      'close_rate', (select case when (select count(*) from scalls where showed)>0 then round((select count(*) from scalls where closed)::numeric/(select count(*) from scalls where showed)*100,1) end),
      'booked_to_close', (select case when (select count(*) from rfc where reached_booked and (p_funnel='all' or funnel=p_funnel))>0 then round((select count(*) from scalls where closed)::numeric/(select count(*) from rfc where reached_booked and (p_funnel='all' or funnel=p_funnel))*100,1) end),
      'cash_collected', (select coalesce(sum(p.amount),0) from payments p left join customers c on c.id=p.customer_id left join leads l on l.id=c.lead_id left join reporting_funnel rf on rf.id=l.id where p.collected_at::date between p_start and p_end and (p_funnel='all' or rf.funnel=p_funnel)),
      'revenue_signed', (select coalesce(sum(contract_value),0) from custf where closed_at::date between p_start and p_end and (p_funnel='all' or funnel=p_funnel)),
      'ltv_cash', (select case when customer_count>0 then round(business_cash_ltv/customer_count,2) else 0 end from ms),
      'ltv_contract', (select case when customer_count>0 then round(business_contract_ltv/customer_count,2) else 0 end from ms),
      'outstanding', (select business_outstanding from ms),
      'disputes', (select count(*) from disputes d left join customers c on c.id=d.customer_id left join leads l on l.id=c.lead_id left join reporting_funnel rf on rf.id=l.id where coalesce(d.opened_at,d.resolved_at,now())::date between p_start and p_end and (p_funnel='all' or rf.funnel=p_funnel)),
      'money_lost_to_disputes', (select coalesce(sum(d.amount),0) from disputes d left join customers c on c.id=d.customer_id left join leads l on l.id=c.lead_id left join reporting_funnel rf on rf.id=l.id where d.status='lost' and coalesce(d.opened_at,d.resolved_at,now())::date between p_start and p_end and (p_funnel='all' or rf.funnel=p_funnel)),
      'dispute_rate', (select case when (select count(*) from custf where closed_at::date between p_start and p_end and (p_funnel='all' or funnel=p_funnel))>0 then round((select count(*) from disputes d left join customers c on c.id=d.customer_id left join leads l on l.id=c.lead_id left join reporting_funnel rf on rf.id=l.id where coalesce(d.opened_at,d.resolved_at,now())::date between p_start and p_end and (p_funnel='all' or rf.funnel=p_funnel))::numeric/(select count(*) from custf where closed_at::date between p_start and p_end and (p_funnel='all' or funnel=p_funnel))*100,1) end)
    ),
    'by_source', (select coalesce(jsonb_agg(jsonb_build_object('source',source,'leads',leads,'booked',booked,'won',won) order by leads desc),'[]'::jsonb)
      from (select channel as source, count(*) leads, count(*) filter (where reached_booked) booked, count(*) filter (where is_won) won from rfc group by channel) s),
    'revenue_by_source', (select coalesce(jsonb_agg(jsonb_build_object('source',source,'clients',clients,'signed',signed,'cash',cash) order by cash desc),'[]'::jsonb)
      from (select coalesce(c.source, rf.channel, 'Unknown') as source, count(*) clients,
              coalesce(sum(c.contract_value),0) signed,
              coalesce(sum((select coalesce(sum(amount),0) from payments p where p.customer_id=c.id)),0) cash
            from customers c left join leads l on l.id=c.lead_id left join reporting_funnel rf on rf.id=l.id
            where c.closed_at::date between p_start and p_end group by 1) s),
    'by_placement', (select coalesce(jsonb_agg(jsonb_build_object('placement',placement,'leads',leads) order by leads desc),'[]'::jsonb)
      from (select coalesce(src_placement,'(none)') as placement, count(*) leads from rfc group by src_placement) s),
    'by_campaign', (select coalesce(jsonb_agg(jsonb_build_object('campaign',campaign,'leads',leads) order by leads desc),'[]'::jsonb)
      from (select coalesce(campaign,'(none)') as campaign, count(*) leads from rfc group by campaign) s),
    'by_booking_method', (select coalesce(jsonb_agg(jsonb_build_object('method',method,'booked',booked) order by booked desc),'[]'::jsonb)
      from (select coalesce(booking_method,'(none)') as method, count(*) booked from rfc where reached_booked group by booking_method) s),
    'reasons_no_close', (select coalesce(jsonb_agg(jsonb_build_object('reason',reason,'name',full_name,'date',call_date) order by call_date desc),'[]'::jsonb) from scalls where outcome='pitched_no_close' and reason is not null),
    'reasons_no_pitch', (select coalesce(jsonb_agg(jsonb_build_object('reason',reason,'name',full_name,'date',call_date) order by call_date desc),'[]'::jsonb) from scalls where outcome='showed_not_pitched' and reason is not null),
    'speed', jsonb_build_object(
      'median_first_reply_seconds', (select round(percentile_cont(0.5) within group (order by t.first_reply_seconds)) from reporting_lead_timing t join rfc on rfc.id=t.lead_id where t.first_reply_seconds is not null),
      'leads_gone_quiet', (select count(*) from rfc where not is_won and not is_lost and not reached_booked and coalesce(disqualify_reason,'')='' and replied)
    )
  )
$function$;


-- =====================================================================
-- 9. TRIGGERS
-- =====================================================================
-- Guarded with DROP TRIGGER IF EXISTS so re-running is safe.

drop trigger if exists clients_updated_at on public.clients;
create trigger clients_updated_at before update on public.clients for each row execute function update_updated_at();

drop trigger if exists leads_updated_at on public.leads;
create trigger leads_updated_at before update on public.leads for each row execute function update_updated_at();

-- =====================================================================
-- END OF SCHEMA
-- =====================================================================
