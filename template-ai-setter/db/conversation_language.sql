-- ============================================================================
-- leads.conversation_language — per-lead language lock for the AI setter
-- ----------------------------------------------------------------------------
-- Applied to your Supabase project on 2026-06-09.
-- Kept here for traceability since the schema otherwise lives only in Supabase.
--
-- Lets a DM thread switch to Swedish and STAY Swedish for the whole
-- conversation (no English<->Swedish flip-flopping). The webhook
-- (src/app/api/webhook/ghl/route.ts) resolves the value each inbound via
-- src/lib/language.ts and feeds it into the reply prompt (src/lib/prompts/master.ts).
--
-- Values:
--   null / 'en'   -> English (default; same behaviour as before this feature)
--   'sv_pending'  -> a Swedish signal was seen; the AI asks "snackar du svenska?"
--                    once and keeps replying in English until they answer
--   'sv'          -> locked Swedish; every reply is in Swedish from here on
--   'en_declined' -> the lead declined Swedish; stay English and never ask again
--
-- Sticky by design: once 'sv', the value is never auto-reverted just because a
-- later message contains some English. Only an explicit request to switch back
-- moves it off Swedish.
-- ============================================================================

alter table public.leads
  add column if not exists conversation_language text;
