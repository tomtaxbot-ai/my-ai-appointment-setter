-- ============================================================================
-- Split the setter's funnel position out of leads.stage + add a reply lock.
-- Applied to the ai-setter Supabase project (migration:
-- setter_funnel_stage_split_and_reply_lock). Kept here for version control.
-- ============================================================================
--
-- THE BUG THIS FIXES
-- ------------------
-- leads.stage was written by TWO systems with incompatible vocabularies:
--   1. The ai-setter funnel engine (lib/stages.ts) wrote funnel ids:
--      "opener", "transition_main_reason", "goals", ...
--   2. The Jarvis GHL pipeline watcher (intelligence/ghl/pipeline_watcher.py)
--      writes the GHL OPPORTUNITY pipeline stage NAME: "New Lead",
--      "Lead Lost", "Appointment Booked", ...
-- Every watcher run reset the setter's saved position back to "New Lead". On
-- the next message the funnel engine no longer recognised its own stage, reset
-- to the first step, and re-asked questions the lead had already answered (and,
-- once a thread was locked to Swedish, leaked the English script lines of the
-- re-fired "transition" step). The lead even asked "is this an AI?".
--
-- THE FIX
-- -------
-- The setter now keeps its funnel position in its OWN column (funnel_stage),
-- which the watcher never touches. leads.stage stays exclusively the GHL
-- pipeline stage (read by Jarvis reporting); leads.stage_data was already
-- setter-only and is unchanged.

-- Setter's funnel position (owned solely by the ai-setter funnel engine).
alter table public.leads
  add column if not exists funnel_stage text;

-- Single-flight reply lock (duplicate-reply guard): prevents two concurrent
-- webhook invocations from both replying to the same lead. Holds the time the
-- lock was taken; a stale lock auto-expires after the webhook's REPLY_LOCK_TTL
-- so a crashed invocation can never deadlock a lead.
alter table public.leads
  add column if not exists reply_lock_at timestamptz;

-- One-time backfill: recover any in-flight funnel positions by copying values
-- that are real funnel ids from the old shared column. GHL pipeline names are
-- left behind (funnel_stage stays null => the engine re-derives the position
-- from the transcript on the next message, which is safe).
update public.leads
set funnel_stage = stage
where funnel_stage is null
  and stage in (
    'opener','transition_main_reason','goals','current_situation','timeline',
    'problem','pitch_help','book','post_book','proof','nurture'
  );
