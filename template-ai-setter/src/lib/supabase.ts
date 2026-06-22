/**
 * Supabase client wrapper.
 *
 * We use the SERVICE_ROLE_KEY here because this code only runs server-side
 * (in API routes). Service role bypasses RLS, which is what we want for
 * the backend — RLS protects future public dashboards, not our own backend.
 *
 * NEVER expose the service role key to the browser. It's in .env.local
 * and Vercel env vars only.
 */

import { createClient } from "@supabase/supabase-js";
import { OWNER_SLUG } from "@/lib/owner";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    "Missing Supabase env vars. Check .env.local for SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
  );
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

// --- Typed table helpers ---

export type Client = {
  id: string;
  name: string;
  slug: string;
  ghl_location_id: string | null;
  ghl_api_key: string | null;
  ghl_calendar_id: string | null;
  system_prompt: string;
  voice_samples: string;
  active_rules: string;
  business_context: string;
  is_active: boolean;
  timezone: string;
  // Owner-configured reply delay range (seconds) set from Jarvis ("wait 20s
  // before replying"). When null, the default fixed debounce applies.
  reply_delay_min_seconds: number | null;
  reply_delay_max_seconds: number | null;
  // Ordered funnel definition (see lib/stages.ts). null/empty => legacy
  // full-script behaviour (no stage tracking).
  stages: unknown[] | null;
  // "Dig deeper into pain" overlay (see lib/paindig.ts). When true, the setter
  // pauses the funnel to explore an emotionally heavy disclosure before
  // resuming. Ships false. pain_protocol optionally overrides the default
  // trigger words + dig style; null => the built-in default protocol.
  pain_dig_enabled?: boolean;
  pain_protocol?: string | null;
  // Voice notes in the operator's cloned voice (see lib/voice.ts). Ships false.
  // setter_voice_id is the ElevenLabs cloned-voice id; null => text only.
  voice_enabled?: boolean;
  setter_voice_id?: string | null;
  setter_voice_id_sv?: string | null;
  // Whale radar (see lib/stages.ts whale score). When true the setter pings the
  // owner the first time a lead scores as a high-value whale.
  whale_radar_enabled?: boolean;
  created_at: string;
  updated_at: string;
};

export type Lead = {
  id: string;
  client_id: string;
  ghl_contact_id: string | null;
  ig_username: string | null;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  status: "new" | "engaged" | "booked" | "done";
  ai_paused: boolean;
  // Per-lead nurture switch (toggled from HQ or Telegram). When true the
  // proactive nurture engine skips this lead even while the system is enabled.
  nurture_paused?: boolean;
  // Per-lead follow-up switch. When true the follow-up engine skips this lead.
  followup_paused?: boolean;
  // Per-lead voice switch. When true the setter never sends this lead voice
  // notes (text only), even while the voice system is on.
  voice_paused?: boolean;
  // Per-lead whale switch. When true the whale radar never pings about this
  // lead, even while the radar is on system-wide.
  whale_paused?: boolean;
  screened: boolean;
  // GHL OPPORTUNITY pipeline stage NAME ("New Lead", "Lead Lost", "Appointment
  // Booked", ...). Owned EXCLUSIVELY by the Jarvis pipeline watcher
  // (intelligence/ghl/pipeline_watcher.py) and read by Jarvis reporting. The
  // setter must NOT read or write this — it uses `funnel_stage` instead.
  stage: string | null;
  // The setter's own conversation state machine (see lib/stages.ts).
  // `funnel_stage` is the funnel stage id the lead is on; `stage_data` holds
  // facts learned so far so the setter never re-asks. Both are owned solely by
  // the setter and are never touched by the pipeline watcher. null/empty for
  // legacy / pre-staging leads. (Was previously stored in `stage`, which
  // collided with the watcher and wiped the setter's memory every sync.)
  funnel_stage: string | null;
  stage_data: Record<string, unknown> | null;
  // Locked conversation language (see lib/language.ts). null/'en' => English
  // (default); 'sv_pending' => asked "snackar du svenska?"; 'sv' => locked
  // Swedish; 'en_declined' => declined Swedish, stay English.
  conversation_language: string | null;
  first_contact_at: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
};

export type DbMessage = {
  id: string;
  lead_id: string;
  client_id: string;
  role: "lead" | "ai" | "human";
  content: string;
  channel: string;
  ghl_message_id: string | null;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
};

/**
 * Run a Supabase query with retries on transient errors.
 *
 * Supabase calls resolve to `{ data, error }` and never reject, so a transient
 * DB/network blip surfaces as a truthy `error`. Callers that simply did
 * `if (error) return null` could not tell "the row doesn't exist" from "the
 * query failed" — which silently dropped lead messages. This helper retries
 * the failing query a few times and THROWS if it never succeeds, so callers
 * can surface a retryable failure instead of masking it as an empty result.
 *
 * On success it returns `data` (which may be null for a genuine no-match).
 */
async function withRetry<T>(
  label: string,
  op: () => PromiseLike<{ data: T | null; error: unknown | null }>,
  attempts = 3
): Promise<T | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, error } = await op();
    if (!error) return data;

    lastError = error;
    console.error(`[supabase] ${label} attempt ${attempt}/${attempts} failed:`, error);
    // Brief linear backoff before retrying a transient failure.
    await new Promise((r) => setTimeout(r, 150 * attempt));
  }

  throw new Error(
    `${label} failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : JSON.stringify(lastError)
    }`
  );
}

/**
 * Get a client by slug. Used for testing / direct lookup.
 */
export async function getClient(slug = OWNER_SLUG): Promise<Client | null> {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("[supabase] getClient failed:", error);
    return null;
  }
  return data as Client | null;
}

/**
 * Get a client by their GHL location ID.
 * This is THE function the webhook uses to route incoming messages
 * to the right client/training in a multi-tenant world.
 *
 * NOTE: this deliberately does NOT filter on is_active. The webhook must
 * find the client even when the setter is globally OFF so the inbound lead +
 * message + events are still recorded — only the REPLY is withheld (the
 * is_active gate lives in route.ts AFTER recording). Filtering here used to
 * silently drop every DM that arrived while paused.
 *
 * Retries transient DB errors and THROWS if the query keeps failing, so the
 * caller can return a retryable status instead of silently treating a
 * database blip as "no client found" and dropping the lead's message.
 * Returns null ONLY when the query succeeds and genuinely matches no client.
 */
export async function getClientByGHLLocation(
  ghl_location_id: string
): Promise<Client | null> {
  return withRetry<Client | null>("getClientByGHLLocation", () =>
    supabase
      .from("clients")
      .select("*")
      .eq("ghl_location_id", ghl_location_id)
      .maybeSingle()
  );
}

/**
 * Find a lead by GHL contact ID, or create one if it doesn't exist.
 * Retries transient DB errors and throws on persistent failure so the caller
 * can return a retryable status instead of dropping the lead's message.
 */
export async function findOrCreateLead(params: {
  client_id: string;
  ghl_contact_id: string;
  ig_username?: string;
  full_name?: string;
}): Promise<Lead | null> {
  const existing = await withRetry<Lead | null>("findOrCreateLead.select", () =>
    supabase
      .from("leads")
      .select("*")
      .eq("client_id", params.client_id)
      .eq("ghl_contact_id", params.ghl_contact_id)
      .maybeSingle()
  );

  if (existing) return existing;

  return withRetry<Lead>("findOrCreateLead.insert", () =>
    supabase
      .from("leads")
      .insert({
        client_id: params.client_id,
        ghl_contact_id: params.ghl_contact_id,
        ig_username: params.ig_username ?? null,
        full_name: params.full_name ?? null,
        status: "new",
      })
      .select("*")
      .single()
  );
}

export async function getRecentMessages(
  lead_id: string,
  limit = 50
): Promise<DbMessage[]> {
  const data = await withRetry<DbMessage[]>("getRecentMessages", () =>
    supabase
      .from("messages")
      .select("*")
      .eq("lead_id", lead_id)
      .order("created_at", { ascending: false })
      .limit(limit)
  );
  return (data ?? []).reverse();
}

/**
 * Fetch the single most recent role='lead' message for a lead. Used by the
 * reply debouncer to tell whether a newer inbound arrived during its wait
 * window (in which case the later invocation owns the reply).
 */
export async function getLatestLeadMessage(
  lead_id: string
): Promise<DbMessage | null> {
  const data = await withRetry<DbMessage[]>("getLatestLeadMessage", () =>
    supabase
      .from("messages")
      .select("*")
      .eq("lead_id", lead_id)
      .eq("role", "lead")
      .order("created_at", { ascending: false })
      .limit(1)
  );
  return data && data.length > 0 ? data[0] : null;
}

export async function saveMessage(params: {
  lead_id: string;
  client_id: string;
  role: "lead" | "ai" | "human";
  content: string;
  channel?: string;
  ghl_message_id?: string;
  model_used?: string;
  input_tokens?: number;
  output_tokens?: number;
}): Promise<DbMessage | null> {
  const data = await withRetry<DbMessage>("saveMessage", () =>
    supabase
      .from("messages")
      .insert({
        lead_id: params.lead_id,
        client_id: params.client_id,
        role: params.role,
        content: params.content,
        channel: params.channel ?? "instagram",
        ghl_message_id: params.ghl_message_id ?? null,
        model_used: params.model_used ?? null,
        input_tokens: params.input_tokens ?? null,
        output_tokens: params.output_tokens ?? null,
      })
      .select("*")
      .single()
  );

  // Best-effort touch of last_message_at; never fail the save over this.
  await supabase
    .from("leads")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", params.lead_id)
    .then(undefined, (err) =>
      console.error("[supabase] last_message_at update failed:", err)
    );

  return data;
}

/**
 * Persist the lead's current funnel stage + accumulated facts. Best-effort:
 * a failure here must never block or break the reply, so we log and move on.
 *
 * Writes the setter's OWN `funnel_stage` column — NOT `stage` (which the Jarvis
 * pipeline watcher owns as the GHL pipeline stage). Keeping these separate is
 * what stops the watcher from wiping the setter's funnel memory on every sync.
 */
export async function updateLeadStage(params: {
  lead_id: string;
  stage: string;
  stage_data: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ funnel_stage: params.stage, stage_data: params.stage_data })
    .eq("id", params.lead_id);
  if (error) console.error("[supabase] updateLeadStage failed:", error);
}

/**
 * Single-flight reply lock (duplicate-reply guard).
 *
 * Each inbound DM spawns its own background webhook invocation, so a lead who
 * fires several messages can have several invocations racing to reply. This
 * lock guarantees only ONE of them generates+sends a reply at a time.
 *
 * Atomic acquire: a single conditional UPDATE that succeeds only if the lock is
 * free OR has gone stale (older than ttlMs). Postgres row-locking serializes
 * concurrent invocations, so exactly one wins. A returned row == lock acquired.
 * The stale-after-ttl clause means a crashed invocation can never deadlock a
 * lead — the lock self-heals after ttlMs (kept > the function's maxDuration).
 */
export async function acquireReplyLock(
  lead_id: string,
  ttlMs: number
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const staleCutoffIso = new Date(Date.now() - ttlMs).toISOString();
  const { data, error } = await supabase
    .from("leads")
    .update({ reply_lock_at: nowIso })
    .eq("id", lead_id)
    .or(`reply_lock_at.is.null,reply_lock_at.lt.${staleCutoffIso}`)
    .select("id");
  if (error) {
    // Fail-safe: if the lock can't be evaluated, DON'T grant it. A missed reply
    // is recoverable (the lead messages again); a double reply is what we're
    // preventing here.
    console.error("[supabase] acquireReplyLock failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** Release the reply lock so the next inbound for this lead can reply. */
export async function releaseReplyLock(lead_id: string): Promise<void> {
  await supabase
    .from("leads")
    .update({ reply_lock_at: null })
    .eq("id", lead_id)
    .then(undefined, (err) =>
      console.error("[supabase] releaseReplyLock failed:", err)
    );
}

/**
 * Persist the lead's locked conversation language (see lib/language.ts).
 * Best-effort: a failure here must never block or break the reply, so we log
 * and move on — the language just won't stick until the next successful write.
 */
export async function updateLeadLanguage(
  lead_id: string,
  language: string
): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ conversation_language: language })
    .eq("id", lead_id);
  if (error) console.error("[supabase] updateLeadLanguage failed:", error);
}

/**
 * Permanently DELETE a lead and ALL of its child rows from the database.
 *
 * Used to erase unsolicited service-pitch spammers caught at first contact:
 * Maher wants them to "not exist", so we remove the messages, AI decisions,
 * and the lead row itself (child rows first to satisfy FK constraints even if
 * no ON DELETE CASCADE is configured). Best-effort — each delete is logged on
 * failure but never throws, so a partial DB hiccup can't crash the background
 * webhook task. Returns true only if the lead row itself was removed.
 *
 * We also delete the lead's existing `events` rows — they carry a FK to
 * leads.id, so leaving them would block the lead delete on a RESTRICT
 * constraint. The caller writes ONE fresh audit event AFTER the purge (with
 * lead_id = null) recording it, so there is a minimal forensic trail if a real
 * lead is ever wrongly erased — without that the deletion would be silent.
 */
export async function purgeLead(lead_id: string): Promise<boolean> {
  // Children first (messages, ai_decisions, events), then the lead row.
  const childTables = ["messages", "ai_decisions", "events"] as const;
  for (const table of childTables) {
    const { error } = await supabase.from(table).delete().eq("lead_id", lead_id);
    if (error) {
      console.error(`[supabase] purgeLead: delete from ${table} failed:`, error);
    }
  }

  const { error } = await supabase.from("leads").delete().eq("id", lead_id);
  if (error) {
    console.error("[supabase] purgeLead: delete lead failed:", error);
    return false;
  }
  return true;
}

export async function logEvent(params: {
  client_id: string;
  lead_id?: string;
  event_type: string;
  metadata?: Record<string, unknown>;
}) {
  await supabase.from("events").insert({
    client_id: params.client_id,
    lead_id: params.lead_id ?? null,
    event_type: params.event_type,
    metadata: params.metadata ?? {},
  });
}

/**
 * Has an event of this type already been logged for this lead?
 *
 * Used by the ongoing tagging pass to stay idempotent: we only add the
 * `qualified` tag (and log `tag_qualified`) the FIRST time a lead qualifies,
 * not on every subsequent inbound message. Best-effort: on a query error we
 * return false so the caller can proceed (adding a GHL tag is itself
 * idempotent — re-adding an existing tag is harmless).
 */
export async function eventExists(
  lead_id: string,
  event_type: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("events")
    .select("id")
    .eq("lead_id", lead_id)
    .eq("event_type", event_type)
    .limit(1);

  if (error) {
    console.error("[supabase] eventExists failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Count AI messages sent to one lead since the given ISO timestamp. Used by
 * the outbound circuit breaker (anti-marathon guard). Returns null on a query
 * error — never 0 — so the caller can tell "no sends" apart from "couldn't
 * check" and choose to fail open.
 */
export async function countAiMessagesSince(
  lead_id: string,
  since_iso: string
): Promise<number | null> {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", lead_id)
    .eq("role", "ai")
    .gte("created_at", since_iso);
  if (error) {
    console.error("[supabase] countAiMessagesSince failed:", error);
    return null;
  }
  return count ?? 0;
}

/** Count AI messages sent across a whole client since the given ISO timestamp. */
export async function countClientAiMessagesSince(
  client_id: string,
  since_iso: string
): Promise<number | null> {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("client_id", client_id)
    .eq("role", "ai")
    .gte("created_at", since_iso);
  if (error) {
    console.error("[supabase] countClientAiMessagesSince failed:", error);
    return null;
  }
  return count ?? 0;
}

/**
 * Has an event of this type been logged since the given time? Scoped to the
 * lead when lead_id is passed, otherwise to the whole client. Lets the rate
 * limiter ping the owner ONCE per episode instead of on every held reply.
 */
export async function recentEventExists(params: {
  client_id: string;
  lead_id?: string;
  event_type: string;
  since_iso: string;
}): Promise<boolean> {
  let q = supabase
    .from("events")
    .select("id")
    .eq("client_id", params.client_id)
    .eq("event_type", params.event_type)
    .gte("created_at", params.since_iso)
    .limit(1);
  if (params.lead_id) q = q.eq("lead_id", params.lead_id);
  const { data, error } = await q;
  if (error) {
    console.error("[supabase] recentEventExists failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Look up a lead by GHL contact id WITHOUT creating one. Used by the outbound
 * (human-message) path, which must never create a lead.
 */
export async function getLeadByContact(
  client_id: string,
  ghl_contact_id: string
): Promise<Lead | null> {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("client_id", client_id)
    .eq("ghl_contact_id", ghl_contact_id)
    .maybeSingle();
  if (error) {
    console.error("[supabase] getLeadByContact failed:", error);
    return null;
  }
  return (data as Lead) ?? null;
}

/** True if we already stored a message with this GHL message id (echo dedupe). */
export async function messageExistsByGhlId(ghl_message_id: string): Promise<boolean> {
  if (!ghl_message_id) return false;
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("ghl_message_id", ghl_message_id)
    .limit(1);
  if (error) {
    console.error("[supabase] messageExistsByGhlId failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** Stamp the GHL message id onto a saved message row (links AI sends to echoes). */
export async function setMessageGhlId(message_id: string, ghl_message_id: string): Promise<void> {
  if (!ghl_message_id) return;
  await supabase
    .from("messages")
    .update({ ghl_message_id })
    .eq("id", message_id)
    .then(undefined, (err) =>
      console.error("[supabase] setMessageGhlId failed:", err)
    );
}

/**
 * Phase 1 — persist a lead's first-touch source. Writes only the fields we
 * actually derived, and ONLY when src_channel isn't already set (first touch
 * wins; never overwritten by later messages). Best-effort.
 */
export async function captureLeadSource(
  lead: Lead,
  src: {
    src_channel: string | null;
    src_placement: string | null;
    src_campaign: string | null;
    src_content: string | null;
    opted_in: boolean;
  },
  attributionRaw?: Record<string, unknown> | null
): Promise<void> {
  // First touch wins: if we already captured a channel, don't clobber it.
  if ((lead as unknown as { src_channel?: string | null }).src_channel) {
    // Still allow flipping opted_in true if a later opt-in form arrives.
    if (src.opted_in && !(lead as unknown as { opted_in?: boolean }).opted_in) {
      await supabase.from("leads").update({ opted_in: true }).eq("id", lead.id)
        .then(undefined, (e) => console.error("[supabase] opted_in update failed:", e));
    }
    return;
  }

  const update: Record<string, unknown> = {};
  if (src.src_channel) update.src_channel = src.src_channel;
  if (src.src_placement) update.src_placement = src.src_placement;
  if (src.src_campaign) update.src_campaign = src.src_campaign;
  if (src.src_content) update.src_content = src.src_content;
  if (src.opted_in) update.opted_in = true;
  if (attributionRaw) update.attribution_raw = attributionRaw;
  if (Object.keys(update).length === 0) return;

  await supabase.from("leads").update(update).eq("id", lead.id)
    .then(undefined, (e) => console.error("[supabase] captureLeadSource failed:", e));
}

/**
 * Phase 3 — set booking_method (idempotent-ish). Never overwrites an existing
 * 'dialing' (the bot owns that) and never re-writes once set.
 */
export async function setBookingMethod(lead_id: string, method: string): Promise<void> {
  const { data } = await supabase
    .from("leads")
    .select("booking_method")
    .eq("id", lead_id)
    .maybeSingle();
  const existing = (data as { booking_method?: string | null } | null)?.booking_method ?? null;
  if (existing === "dialing") return; // never overwrite a dial booking
  if (existing) return; // already set
  await supabase.from("leads").update({ booking_method: method }).eq("id", lead_id)
    .then(undefined, (e) => console.error("[supabase] setBookingMethod failed:", e));
}

/**
 * Phase 6 — record why a lead was disqualified ('financial' | 'no_intent' |
 * 'friend_family'). First write wins; never overwritten.
 */
export async function setDisqualifyReason(lead_id: string, reason: string): Promise<void> {
  const { data } = await supabase
    .from("leads")
    .select("disqualify_reason")
    .eq("id", lead_id)
    .maybeSingle();
  if ((data as { disqualify_reason?: string | null } | null)?.disqualify_reason) return;
  await supabase.from("leads").update({ disqualify_reason: reason }).eq("id", lead_id)
    .then(undefined, (e) => console.error("[supabase] setDisqualifyReason failed:", e));
}

export async function logAIDecision(params: {
  lead_id: string;
  client_id: string;
  message_id?: string;
  system_prompt_used: string;
  conversation_context: unknown;
  raw_response: string;
  final_reply?: string;
  duration_ms?: number;
  error?: string;
}) {
  await supabase.from("ai_decisions").insert({
    lead_id: params.lead_id,
    client_id: params.client_id,
    message_id: params.message_id ?? null,
    system_prompt_used: params.system_prompt_used,
    conversation_context: params.conversation_context,
    raw_response: params.raw_response,
    final_reply: params.final_reply ?? null,
    duration_ms: params.duration_ms ?? null,
    error: params.error ?? null,
  });
}
