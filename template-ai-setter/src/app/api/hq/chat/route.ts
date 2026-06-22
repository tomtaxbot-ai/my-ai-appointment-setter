/**
 * JARVIS HQ — chat brain: real lookups AND real actions, by voice.
 *
 * READ tools:
 *   - get_business_data   → aggregate funnel/sales/sources (same get_dashboard RPC)
 *   - get_recent_bookings → actual NAMES of recently booked leads
 *   - get_closed_deals    → actual NAMES behind the money: who signed, who paid
 *   - find_lead           → quick lead search by name/handle
 *   - lead_story          → full deep-dive on one lead (source, stage, facts, history)
 *   - get_conversation    → the actual DM thread with a lead (for a convo panel)
 *   - get_hot_leads       → most active engaged leads right now
 *   - get_morning_brief   → the flight check: cash, bookings, cold leads, focus
 *
 * ACTION tools (scoped to the TEU client):
 *   - send_dm        → send a lead a message via GHL (confirm-first, prompt-enforced)
 *   - set_lead_ai    → turn the AI setter on/off for a lead (db + "ai off" tag)
 *   - manage_tags    → add/remove GHL tags on a lead
 *   - move_pipeline  → move a lead's GHL opportunity to another pipeline stage
 *
 * POST /api/hq/chat?k=<key>  body: { message, history }  → { speech, panels, clear }
 */
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase, saveMessage, logEvent, type Client, type Lead } from "@/lib/supabase";
import { OWNER_SLUG } from "@/lib/owner";
import {
  sendGHLMessage, addContactTags, removeContactTags,
  findContactOpportunity, listPipelines, moveOpportunityStage,
} from "@/lib/ghl";
import { getAccessKey } from "@/lib/access";
import { normalizeHandle } from "@/lib/bans";
import { runDmIntel, getLatestDmReport } from "@/lib/dmintel";
import { waitUntil } from "@vercel/functions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4-6";
const STOP_TAGS = ["ai off", "ai-off", "aioff", "stop ai", "stop-ai", "stopai"];

function pad(n: number) { return String(n).padStart(2, "0"); }
function isoDate(d: Date) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function rangeFor(period: string): { start: string; end: string } {
  const now = new Date();
  const end = isoDate(now);
  const p = (period || "").toLowerCase().replace(/\s+/g, "_");
  const back = (days: number) => isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)));
  if (p === "today") return { start: end, end };
  if (p === "yesterday") return { start: back(1), end: back(1) };
  if (p === "last_7_days" || p === "7d" || p === "past_week") return { start: back(6), end };
  if (p === "last_30_days" || p === "30d") return { start: back(29), end };
  if (p === "week" || p === "this_week") { const day = now.getUTCDay(); return { start: back(day === 0 ? 6 : day - 1), end }; }
  if (p === "month" || p === "this_month") return { start: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`, end };
  if (p === "year" || p === "this_year") return { start: `${now.getUTCFullYear()}-01-01`, end };
  if (p === "all" || p === "all_time") return { start: "2000-01-01", end };
  return { start: back(6), end };
}
function sinceISO(days: number) { return new Date(Date.now() - days * 86400_000).toISOString(); }

function leadBrief(l: Lead) {
  return {
    name: l.full_name || l.ig_username || "unknown",
    handle: l.ig_username || "",
    status: l.status || "",
    pipeline_stage: l.stage || "",
    ai_paused: !!l.ai_paused,
    last_message_at: l.last_message_at,
  };
}

/** Find the best lead match for a spoken name/handle (TEU-scoped). */
async function resolveLead(clientId: string, query: string): Promise<{ lead: Lead | null; matches: ReturnType<typeof leadBrief>[] }> {
  const q = (query || "").trim().replace(/^@/, "").replace(/[%,()]/g, "");
  if (!q) return { lead: null, matches: [] };
  const { data } = await supabase
    .from("leads")
    .select("*")
    .eq("client_id", clientId)
    .or(`full_name.ilike.%${q}%,ig_username.ilike.%${q}%`)
    .order("last_message_at", { ascending: false })
    .limit(5);
  const rows = (data ?? []) as Lead[];
  return { lead: rows[0] ?? null, matches: rows.map(leadBrief) };
}

/** Map a stored message channel to the GHL send type. */
function ghlTypeFor(channel: string): "IG" | "SMS" | "Email" | "WhatsApp" | "FB" {
  const c = (channel || "").toLowerCase();
  if (c.includes("sms")) return "SMS";
  if (c.includes("whats")) return "WhatsApp";
  if (c.includes("fb") || c.includes("facebook")) return "FB";
  if (c.includes("email")) return "Email";
  return "IG";
}

/**
 * The TEU client row, ignoring is_active — that flag is the setter's
 * auto-reply switch (Maher pauses it routinely) and must NOT take HQ's
 * lookups, conversations, and sends down with it.
 */
async function getHqClient(): Promise<Client | null> {
  const { data } = await supabase.from("clients").select("*").eq("slug", OWNER_SLUG).maybeSingle();
  return (data as Client | null) ?? null;
}

// ───────────────────────────── READ tools ─────────────────────────────

async function getBusinessData(period: string, source?: string, funnel?: string) {
  const { start, end } = rangeFor(period);
  const { data, error } = await supabase.rpc("get_dashboard", {
    p_start: start, p_end: end, p_source: source || null,
    p_funnel: funnel && ["all", "outbound", "inbound"].includes(funnel) ? funnel : "all",
  });
  if (error) return { error: error.message };
  return { period, start, end, ...(data as object) };
}

/**
 * Bookings the EXACT way the TEU dashboard counts them: reporting_funnel rows
 * with reached_booked, filtered by lead date. NOT the events table — its
 * appointment_booked rows include the pipeline watcher's historical "ever
 * booked" stamps, which once made Jarvis claim 10 bookings in a week the
 * dashboard showed as 0.
 */
async function getRecentBookings(period = "last_30_days", limit = 10) {
  const { start, end } = rangeFor(period);
  const { data } = await supabase
    .from("reporting_funnel")
    .select("id, lead_date, channel, funnel, ai_booked")
    .eq("reached_booked", true)
    .gte("lead_date", `${start}T00:00:00Z`)
    .lte("lead_date", `${end}T23:59:59Z`)
    .order("lead_date", { ascending: false })
    .limit(limit);
  const rows = await Promise.all((data ?? []).map(async (r) => {
    let name = "unknown", handle = "";
    const { data: l } = await supabase.from("leads").select("full_name, ig_username").eq("id", r.id).maybeSingle();
    if (l) { name = l.full_name || l.ig_username || "unknown"; handle = l.ig_username || ""; }
    return { name, handle, source: r.channel || "", funnel: r.funnel || "", ai_booked: !!r.ai_booked, lead_date: r.lead_date };
  }));
  return {
    period,
    booked_count: rows.length,
    note: "counted exactly like the TEU dashboard (leads from this period who reached booked)",
    bookings: rows,
  };
}

async function findLead(clientId: string, query: string) {
  const { matches } = await resolveLead(clientId, query);
  return { matches };
}

/**
 * The NAMES behind the money — customers + their payments, the same tables
 * the dashboard's revenue numbers come from. closed_at drives the period.
 */
async function getClosedDeals(period = "last_30_days", limit = 12) {
  const { start, end } = rangeFor(period);
  const { data } = await supabase
    .from("customers")
    .select("id, name, contract_value, currency, closer, closed_at, status, source, booking_method")
    .gte("closed_at", `${start}T00:00:00Z`)
    .lte("closed_at", `${end}T23:59:59Z`)
    .order("closed_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 25));
  const deals = await Promise.all((data ?? []).map(async (c) => {
    const { data: pays } = await supabase
      .from("payments").select("amount, kind, collected_at")
      .eq("customer_id", c.id).order("collected_at", { ascending: true });
    const cash = (pays ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return {
      name: c.name || "unknown",
      signed: Number(c.contract_value) || 0,
      cash_collected: cash,
      payments_made: (pays ?? []).length,
      closer: c.closer || "",
      closed_at: c.closed_at,
      status: c.status || "",
      source: c.source || "",
      booking_method: c.booking_method || "",
    };
  }));
  return {
    period,
    deal_count: deals.length,
    total_signed: deals.reduce((s, d) => s + d.signed, 0),
    total_cash_collected: deals.reduce((s, d) => s + d.cash_collected, 0),
    deals,
  };
}

async function leadStory(clientId: string, query: string) {
  const { lead, matches } = await resolveLead(clientId, query);
  if (!lead) return { found: false, matches };
  const [msgs, bookEvents, msgCount] = await Promise.all([
    supabase.from("messages").select("role, content, channel, created_at").eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(6),
    supabase.from("events").select("event_type, created_at").eq("lead_id", lead.id).in("event_type", ["call_booked", "appointment_booked", "lead_disqualified"]).order("created_at", { ascending: false }).limit(5),
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("lead_id", lead.id),
  ]);
  const leadRow = lead as Lead & { source?: string };
  return {
    found: true,
    other_matches: matches.length > 1 ? matches.slice(1) : [],
    profile: {
      ...leadBrief(lead),
      source: leadRow.source || "",
      email: lead.email || "",
      phone: lead.phone || "",
      funnel_stage: lead.funnel_stage || "",
      facts_learned: lead.stage_data || {},
      first_contact_at: lead.first_contact_at,
      created_at: lead.created_at,
      total_messages: msgCount.count ?? 0,
    },
    key_events: bookEvents.data ?? [],
    last_messages: (msgs.data ?? []).reverse().map((m) => ({
      from: m.role === "lead" ? "lead" : "us", text: String(m.content || "").slice(0, 280), channel: m.channel, at: m.created_at,
    })),
  };
}

async function getConversation(clientId: string, query: string, limit = 14) {
  const { lead, matches } = await resolveLead(clientId, query);
  if (!lead) return { found: false, matches };
  const { data } = await supabase
    .from("messages")
    .select("role, content, channel, created_at")
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 4), 30));
  return {
    found: true,
    lead: leadBrief(lead),
    other_matches: matches.length > 1 ? matches.slice(1) : [],
    messages: (data ?? []).reverse().map((m) => ({
      from: m.role === "lead" ? "lead" : "us", text: String(m.content || "").slice(0, 300), channel: m.channel, at: m.created_at,
    })),
  };
}

async function getHotLeads(clientId: string, limit = 6) {
  const { data } = await supabase
    .from("leads")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "engaged")
    .eq("ai_paused", false)
    .order("last_message_at", { ascending: false })
    .limit(15);
  const candidates = (data ?? []) as Lead[];
  const scored = await Promise.all(candidates.map(async (l) => {
    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", l.id)
      .eq("role", "lead")
      .gte("created_at", sinceISO(3));
    return { ...leadBrief(l), funnel_stage: l.funnel_stage || "", replies_last_3d: count ?? 0 };
  }));
  scored.sort((a, b) => b.replies_last_3d - a.replies_last_3d || (b.last_message_at || "").localeCompare(a.last_message_at || ""));
  return { hot_leads: scored.slice(0, Math.min(Math.max(limit, 3), 10)) };
}

async function getMorningBrief(clientId: string) {
  const [yesterday, week, bookings, cold, newToday] = await Promise.all([
    getBusinessData("yesterday"),
    getBusinessData("last_7_days"),
    getRecentBookings("last_7_days", 5),
    supabase.from("leads").select("full_name, ig_username, last_message_at")
      .eq("client_id", clientId).eq("status", "engaged").eq("ai_paused", false)
      .lt("last_message_at", sinceISO(2)).gt("last_message_at", sinceISO(5))
      .order("last_message_at", { ascending: false }).limit(5),
    supabase.from("leads").select("id", { count: "exact", head: true })
      .eq("client_id", clientId).gt("created_at", sinceISO(1)),
  ]);
  return {
    yesterday, last_7_days: week,
    recent_bookings: bookings.bookings,
    leads_going_cold: (cold.data ?? []).map((l) => ({
      name: l.full_name || l.ig_username || "unknown", handle: l.ig_username || "", last_heard: l.last_message_at,
    })),
    new_leads_today: newToday.count ?? 0,
  };
}

/**
 * Numbers for casual questions — pulled from the SAME get_dashboard RPC the
 * dashboard uses so Jarvis never disagrees with it (raw table counts diverge:
 * bulk imports + watcher stamps inflate them).
 */
async function quickPulse() {
  const [dash, engaged] = await Promise.all([
    getBusinessData("last_7_days"),
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("status", "engaged"),
  ]);
  const d = dash as { sales?: { booked?: number; cash_collected?: number }; by_source?: Array<{ leads?: number }> };
  return {
    leads_7d: (d.by_source ?? []).reduce((s, r) => s + (Number(r.leads) || 0), 0),
    engaged_now: engaged.count ?? 0,
    booked_7d: Number(d.sales?.booked) || 0,
    cash_7d: Number(d.sales?.cash_collected) || 0,
  };
}

// ──────────────────────────── ACTION tools ────────────────────────────

async function sendDm(client: Client, query: string, message: string) {
  const text = (message || "").trim();
  if (!text) return { sent: false, error: "empty_message" };
  const { lead, matches } = await resolveLead(client.id, query);
  if (!lead) return { sent: false, error: "lead_not_found", matches };
  if (!client.ghl_api_key || !client.ghl_location_id || !lead.ghl_contact_id) {
    return { sent: false, error: "missing_ghl_credentials_or_contact" };
  }
  const { data: lastMsg } = await supabase
    .from("messages").select("channel").eq("lead_id", lead.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const channel = lastMsg?.channel || "instagram";
  const result = await sendGHLMessage({
    ghl_api_key: client.ghl_api_key,
    ghl_location_id: client.ghl_location_id,
    ghl_contact_id: lead.ghl_contact_id,
    message: text,
    type: ghlTypeFor(channel),
  });
  if (!result.success) return { sent: false, error: result.error, lead: leadBrief(lead) };
  await saveMessage({
    lead_id: lead.id, client_id: client.id, role: "human", content: text,
    channel, ghl_message_id: result.ghl_message_id,
  });
  await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "human_message_sent", metadata: { via: "jarvis_hq" } });
  return { sent: true, to: leadBrief(lead), channel };
}

async function setLeadAi(client: Client, query: string, on: boolean) {
  const { lead, matches } = await resolveLead(client.id, query);
  if (!lead) return { done: false, error: "lead_not_found", matches };
  const { error } = await supabase.from("leads").update({ ai_paused: !on }).eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  if (client.ghl_api_key && lead.ghl_contact_id) {
    if (on) await removeContactTags(client.ghl_api_key, lead.ghl_contact_id, STOP_TAGS);
    else await addContactTags(client.ghl_api_key, lead.ghl_contact_id, [STOP_TAGS[0]]);
  }
  await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "ai_toggled", metadata: { on, via: "jarvis_hq" } });
  return { done: true, lead: leadBrief(lead), ai_now: on ? "on" : "off" };
}

async function manageTags(client: Client, query: string, add: string[], remove: string[]) {
  const { lead, matches } = await resolveLead(client.id, query);
  if (!lead) return { done: false, error: "lead_not_found", matches };
  if (!client.ghl_api_key || !lead.ghl_contact_id) return { done: false, error: "missing_ghl_credentials_or_contact" };
  const out: Record<string, unknown> = { lead: leadBrief(lead) };
  if (add.length) { const r = await addContactTags(client.ghl_api_key, lead.ghl_contact_id, add); out.added = r.success ? add : `failed: ${r.error}`; }
  if (remove.length) { const r = await removeContactTags(client.ghl_api_key, lead.ghl_contact_id, remove); out.removed = r.success ? remove : `failed: ${r.error}`; }
  out.done = true;
  return out;
}

/** SYSTEM-WIDE setter switch — same clients.is_active flag the Telegram bot flips. */
async function setSetterSystem(on: boolean) {
  const { error } = await supabase.from("clients").update({ is_active: on }).eq("slug", OWNER_SLUG);
  if (error) return { done: false, error: error.message };
  clientCache = null; // the HQ's cached client row just changed state
  return { done: true, setter_now: on ? "ON — replying to leads" : "OFF — paused system-wide" };
}

/** SYSTEM-WIDE nurture switch (clients.nurture_enabled). On enable, stamp
 *  nurture_enabled_at = now so it never reaches back to pre-enable leads. */
async function setNurtureSystem(on: boolean) {
  const patch: Record<string, unknown> = { nurture_enabled: on };
  if (on) patch.nurture_enabled_at = new Date().toISOString();
  const { error } = await supabase.from("clients").update(patch).eq("slug", OWNER_SLUG);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, nurture_now: on ? "ON — booked leads get the warm-up sequence" : "OFF — no nurture sends" };
}

/** Per-lead nurture switch (leads.nurture_paused). on=true → nurtured; on=false → skipped. */
async function setNurtureLead(client: Client, query: string, on: boolean) {
  const { lead, matches } = await resolveLead(client.id, query);
  if (!lead) return { done: false, error: "lead_not_found", matches };
  const { error } = await supabase.from("leads").update({ nurture_paused: !on }).eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  return { done: true, lead: leadBrief(lead), nurture_now: on ? "on" : "off" };
}

const FUNNEL_ORDER = ["opener", "transition_main_reason", "goals", "current_situation", "timeline", "problem", "pitch_help", "book", "post_book", "proof", "nurture"];
const STAGE_LABEL: Record<string, string> = {
  opener: "Opener", transition_main_reason: "Main reason", goals: "Goals", current_situation: "Situation",
  timeline: "Timeline", problem: "Problem", pitch_help: "Pitch", book: "Booking", post_book: "Post-book", proof: "Proof", nurture: "Nurture",
};
/** Follow-up performance + the leak map (where leads die). */
async function getFollowupStats() {
  const [sum, leak] = await Promise.all([
    supabase.from("reporting_followups").select("*").maybeSingle(),
    supabase.from("reporting_leak_map").select("*"),
  ]);
  const leakRows = ((leak.data ?? []) as { funnel_stage: string; stalled: number }[])
    .map((r) => ({ stage: STAGE_LABEL[r.funnel_stage] || r.funnel_stage, stalled: r.stalled }))
    .sort((a, b) => FUNNEL_ORDER.indexOf(Object.keys(STAGE_LABEL).find((k) => STAGE_LABEL[k] === a.stage) || a.stage) - FUNNEL_ORDER.indexOf(Object.keys(STAGE_LABEL).find((k) => STAGE_LABEL[k] === b.stage) || b.stage));
  const s = (sum.data ?? {}) as Record<string, number>;
  return {
    follow_ups_sent_7d: s.sent_7d ?? 0, follow_ups_sent_30d: s.sent_30d ?? 0, follow_ups_sent_total: s.sent_total ?? 0,
    leads_revived_7d: s.revived_7d ?? 0, leads_revived_total: s.revived_total ?? 0,
    leads_rebooked_total: s.rebooked_total ?? 0,
    where_leads_die: leakRows, // stalled-lead count per funnel stage, in funnel order
  };
}

/** SYSTEM-WIDE follow-up switch (clients.followup_enabled). On enable, stamp
 *  followup_enabled_at so it only acts on stalls from now on. */
async function setFollowupSystem(on: boolean) {
  const patch: Record<string, unknown> = { followup_enabled: on };
  if (on) patch.followup_enabled_at = new Date().toISOString();
  const { error } = await supabase.from("clients").update(patch).eq("slug", OWNER_SLUG);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, followups_now: on ? "ON — quiet leads get re-engaged" : "OFF — no follow-up sends" };
}

/** SYSTEM-WIDE DM-intelligence switch (clients.dm_intel_enabled) — governs ONLY
 *  the automatic MONTHLY analysis + ping. On-demand analysis works regardless. */
async function setDmIntelSystem(on: boolean) {
  const { error } = await supabase.from("clients").update({ dm_intel_enabled: on }).eq("slug", OWNER_SLUG);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, dm_intel_now: on ? "ON — monthly DM analysis + ping (you can still run it on demand any time)" : "OFF — no automatic monthly run (you can still run it on demand any time)" };
}

/** SYSTEM-WIDE whale-radar switch (clients.whale_radar_enabled). When on, the
 *  setter scores leads on expected value and pings Maher about high-value ones. */
async function setWhaleRadarSystem(on: boolean) {
  const { error } = await supabase.from("clients").update({ whale_radar_enabled: on }).eq("slug", OWNER_SLUG);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, whale_radar_now: on ? "ON — you get a Telegram ping when a high-value lead shows up" : "OFF — no whale alerts" };
}

/** SYSTEM-WIDE "dig deeper into pain" switch (clients.pain_dig_enabled). When on,
 *  the setter pauses the funnel to explore an emotionally heavy disclosure, then
 *  resumes. Tune the trigger words/style via the pain_protocol brain field. */
async function setPainDigSystem(on: boolean) {
  const { error } = await supabase.from("clients").update({ pain_dig_enabled: on }).eq("slug", OWNER_SLUG);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, pain_dig_now: on ? "ON — when a lead shares something heavy, the setter pauses, digs into the pain with empathy, then picks the conversation back up" : "OFF — the setter runs the normal flow, no pain-digging" };
}

/** SYSTEM-WIDE voice-notes switch (clients.voice_enabled). When on, the setter
 *  can reply with voice notes in the operator's cloned voice on the right beats. */
async function setVoiceSystem(on: boolean) {
  const { error } = await supabase.from("clients").update({ voice_enabled: on }).eq("slug", OWNER_SLUG);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, voice_now: on ? "ON — the setter can send voice notes in your cloned voice (text for links/times)" : "OFF — text only, no voice notes" };
}

/** Per-lead voice switch (leads.voice_paused). on=true → can get voice notes; on=false → text only. */
async function setVoiceLead(client: Client, query: string, on: boolean) {
  const { lead, matches } = await resolveLead(client.id, query);
  if (!lead) return { done: false, error: "lead_not_found", matches };
  const { error } = await supabase.from("leads").update({ voice_paused: !on }).eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  return { done: true, lead: leadBrief(lead), voice_now: on ? "on" : "off" };
}

/** Per-lead whale-radar switch (leads.whale_paused). on=true → can ping; on=false → muted. */
async function setWhaleLead(client: Client, query: string, on: boolean) {
  const { lead, matches } = await resolveLead(client.id, query);
  if (!lead) return { done: false, error: "lead_not_found", matches };
  const { error } = await supabase.from("leads").update({ whale_paused: !on }).eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  return { done: true, lead: leadBrief(lead), whale_radar_now: on ? "on" : "off" };
}

/** Voice-note usage over a recent window (in hours). Counts notes actually sent. */
async function getVoiceStats(hours: number) {
  const sinceIso = new Date(Date.now() - Math.max(1, hours) * 3600_000).toISOString();
  const { data } = await supabase
    .from("events")
    .select("metadata")
    .in("event_type", ["ai_replied", "ai_reply_failed"])
    .gte("created_at", sinceIso);
  let voiceNotes = 0, replies = 0;
  for (const e of (data ?? []) as { metadata: { voice_notes?: number } | null }[]) {
    voiceNotes += Number(e.metadata?.voice_notes || 0);
    replies += 1;
  }
  const label = hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
  return { window: label, voice_notes_sent: voiceNotes, ai_replies: replies };
}

// ─── SETTER BRAIN EDITS (apply a DM-intel fix, or any brain change, from the orbit) ───
// Mirrors the Telegram brain-edit flow and shares the same setter_brain_versions
// table, so 'undo' works across both surfaces. Writes are confirm-gated.
const BRAIN_FIELDS = ["system_prompt", "active_rules", "voice_samples", "business_context", "pain_protocol"] as const;
type BrainField = (typeof BRAIN_FIELDS)[number];
const isBrainField = (f: string): f is BrainField => (BRAIN_FIELDS as readonly string[]).includes(f);

/** Read one brain field (so a change can be composed against the real current text). */
async function getBrainField(field: string) {
  if (!isBrainField(field)) return { error: "unknown_field", fields: BRAIN_FIELDS };
  const { data } = await supabase.from("clients").select(field).eq("slug", OWNER_SLUG).maybeSingle();
  const value = (data as Record<string, unknown> | null)?.[field];
  return { field, value: (typeof value === "string" && value) ? value : "(empty)" };
}

/** Save a brain field (FULL new text). Confirm-gated; keeps the prior version for undo. */
async function setBrainField(client: Client, field: string, newValue: string, confirmed: boolean) {
  if (!isBrainField(field)) return { done: false, error: "unknown_field", fields: BRAIN_FIELDS };
  if (!confirmed) return { done: false, error: "not_confirmed", note: "Show Maher exactly what will change and wait for his yes, then call again with confirmed=true." };
  if (!newValue.trim()) return { done: false, error: "refusing_empty", note: "Won't save an empty brain field." };
  const { data: cur } = await supabase.from("clients").select(field).eq("id", client.id).maybeSingle();
  const oldValue = (cur as Record<string, unknown> | null)?.[field] ?? null;
  await supabase.from("setter_brain_versions").insert({ client_id: client.id, field, old_value: oldValue, new_value: newValue, changed_by: "Maher (Jarvis HQ)" });
  const { error } = await supabase.from("clients").update({ [field]: newValue }).eq("id", client.id);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, field, chars: newValue.length, note: "Saved. Live on the setter's next reply. Say 'undo that' to roll it back." };
}

/** Restore the most recent prior version of a brain field ('undo that'). Confirm-gated. */
async function undoBrainField(client: Client, field: string, confirmed: boolean) {
  if (!isBrainField(field)) return { done: false, error: "unknown_field", fields: BRAIN_FIELDS };
  if (!confirmed) return { done: false, error: "not_confirmed", note: "Confirm with Maher, then call again with confirmed=true." };
  const { data: versions } = await supabase.from("setter_brain_versions")
    .select("id, old_value, changed_at").eq("client_id", client.id).eq("field", field)
    .order("changed_at", { ascending: false }).limit(1);
  const v = (versions ?? [])[0] as { old_value: string | null } | undefined;
  if (!v) return { done: false, error: "no_versions", note: `No saved versions of ${field} to restore.` };
  const { data: cur } = await supabase.from("clients").select(field).eq("id", client.id).maybeSingle();
  const current = (cur as Record<string, unknown> | null)?.[field] ?? null;
  await supabase.from("setter_brain_versions").insert({ client_id: client.id, field, old_value: current, new_value: v.old_value, changed_by: "Maher (Jarvis HQ, undo)" });
  const { error } = await supabase.from("clients").update({ [field]: v.old_value }).eq("id", client.id);
  if (error) return { done: false, error: error.message };
  clientCache = null;
  return { done: true, field, restored_chars: (v.old_value || "").length, note: "Restored. Live on the next reply." };
}

/** Per-lead follow-up switch (leads.followup_paused). on=true → followed up; on=false → skipped. */
async function setFollowupLead(client: Client, query: string, on: boolean) {
  const { lead, matches } = await resolveLead(client.id, query);
  if (!lead) return { done: false, error: "lead_not_found", matches };
  const { error } = await supabase.from("leads").update({ followup_paused: !on }).eq("id", lead.id);
  if (error) return { done: false, error: error.message };
  return { done: true, lead: leadBrief(lead), followups_now: on ? "on" : "off" };
}

/** Ban: write the banned_contacts row (the webhook enforces it on every inbound) + pause AI. */
async function banLead(client: Client, query: string, reason: string) {
  const { lead, matches } = await resolveLead(client.id, query);
  if (!lead) return { done: false, error: "lead_not_found", matches };
  const { error } = await supabase.from("banned_contacts").insert({
    client_id: client.id,
    ghl_contact_id: lead.ghl_contact_id || null,
    ig_username: normalizeHandle(lead.ig_username),
    full_name: lead.full_name || null,
    reason: reason || "banned via Jarvis HQ",
    active: true,
  });
  if (error) return { done: false, error: error.message };
  await supabase.from("leads").update({ ai_paused: true }).eq("id", lead.id);
  await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "lead_banned", metadata: { via: "jarvis_hq", reason } });
  return { done: true, banned: leadBrief(lead) };
}

async function unbanLead(client: Client, query: string) {
  const q = normalizeHandle(query) || (query || "").trim().toLowerCase();
  if (!q) return { done: false, error: "empty_query" };
  const { data } = await supabase
    .from("banned_contacts")
    .select("id, ig_username, full_name")
    .eq("client_id", client.id).eq("active", true);
  const hit = (data ?? []).find((b) =>
    (b.ig_username || "").toLowerCase() === q || (b.full_name || "").toLowerCase().includes(q));
  if (!hit) return { done: false, error: "no_active_ban_matched", active_bans: (data ?? []).map((b) => b.full_name || b.ig_username) };
  const { error } = await supabase.from("banned_contacts").update({ active: false }).eq("id", hit.id);
  if (error) return { done: false, error: error.message };
  return { done: true, unbanned: hit.full_name || hit.ig_username };
}

async function listBans(client: Client) {
  const { data } = await supabase
    .from("banned_contacts").select("ig_username, full_name, reason")
    .eq("client_id", client.id).eq("active", true);
  return { active_bans: (data ?? []).map((b) => ({ name: b.full_name || "", handle: b.ig_username || "", reason: b.reason || "" })) };
}

async function movePipeline(client: Client, query: string, stageName: string) {
  const { lead, matches } = await resolveLead(client.id, query);
  if (!lead) return { done: false, error: "lead_not_found", matches };
  if (!client.ghl_api_key || !client.ghl_location_id || !lead.ghl_contact_id) {
    return { done: false, error: "missing_ghl_credentials_or_contact" };
  }
  const opp = await findContactOpportunity(client.ghl_api_key, client.ghl_location_id, lead.ghl_contact_id);
  if (!opp) return { done: false, error: "no_pipeline_opportunity_for_this_lead", lead: leadBrief(lead) };
  const pipelines = await listPipelines(client.ghl_api_key, client.ghl_location_id);
  const want = (stageName || "").trim().toLowerCase();
  let target: { pipelineId: string; stageId: string; stageName: string } | null = null;
  for (const p of pipelines) {
    if (opp.pipelineId && p.id !== opp.pipelineId) continue;
    const s = p.stages.find((st) => st.name.toLowerCase() === want) || p.stages.find((st) => st.name.toLowerCase().includes(want));
    if (s) { target = { pipelineId: p.id, stageId: s.id, stageName: s.name }; break; }
  }
  if (!target) {
    const available = pipelines.filter((p) => !opp.pipelineId || p.id === opp.pipelineId).flatMap((p) => p.stages.map((s) => s.name));
    return { done: false, error: "stage_not_found", available_stages: available };
  }
  const r = await moveOpportunityStage(client.ghl_api_key, opp.id, target.pipelineId, target.stageId);
  if (!r.success) return { done: false, error: r.error };
  await supabase.from("leads").update({ stage: target.stageName }).eq("id", lead.id);
  await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "pipeline_moved", metadata: { to: target.stageName, via: "jarvis_hq" } });
  return { done: true, lead: leadBrief(lead), moved_to: target.stageName };
}

// ─────────────────────────── tool definitions ───────────────────────────

const LEAD_Q = { query: { type: "string", description: "the lead's name or @handle (just the name, e.g. 'Alex')" } };

const TOOLS = [
  {
    name: "get_business_data",
    description: "Aggregate funnel, sales/cash, sources, and speed metrics for a period. Backed by the dashboard's data. Use for numbers/percentages/cash/funnel questions.",
    input_schema: { type: "object" as const, properties: {
      period: { type: "string", enum: ["today", "yesterday", "last_7_days", "last_30_days", "week", "month", "year", "all"] },
      source: { type: "string" }, funnel: { type: "string", enum: ["all", "outbound", "inbound"] },
    }, required: ["period"] },
  },
  {
    name: "get_recent_bookings",
    description: "The actual NAMES of leads who booked a call, counted EXACTLY like the TEU dashboard (its numbers are the truth). Use whenever Maher asks WHO booked, the name of a booked lead, how many booked, or for a list of recent bookings.",
    input_schema: { type: "object" as const, properties: {
      period: { type: "string", enum: ["today", "last_7_days", "last_30_days", "month", "all"] },
      limit: { type: "number" },
    }, required: [] },
  },
  {
    name: "run_dm_analysis",
    description: "Kick off the DM INTELLIGENCE analysis (mines winning vs losing conversations for patterns + the top 1-3 fixes). Use for 'analyze my DMs', 'what should I fix in the setter', 'study my conversations'. Read-only: it only produces a report, it changes nothing. It runs in the BACKGROUND (~30s) and returns INSTANTLY with {started:true} — it does NOT return the report. Tell Maher it's running and to ask for the report in ~30s; then use get_dm_report to show it.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_dm_report",
    description: "Read the latest DM INTELLIGENCE report — what it did, the findings, and the pending fixes. Use for 'show me the DM report', 'what did the analysis find', 'what are the suggestions'. Returns a ready 'report_panel' — put it in panels VERBATIM. Suggestions are advisory; applying one needs your explicit approval via the brain-edit flow.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "set_dm_intel_system",
    description: "ACTION: turn the automatic MONTHLY DM-intelligence run + ping on or off ('turn the monthly DM analysis on/off', 'stop the monthly DM study'). Off just stops the timer — you can still run an analysis on demand any time. It never changes the setter either way.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  {
    name: "set_voice_system",
    description: "ACTION: turn VOICE NOTES on or off SYSTEM-WIDE ('turn voice notes on/off', 'stop sending voice messages', 'use my voice', 'go back to text only'). When ON, the setter can reply with a voice note in the operator's cloned voice on the human/persuasion beats; links and times always stay text. Kill switch if anything sounds off.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  {
    name: "set_voice_lead",
    description: "ACTION: turn voice notes on/off for ONE specific lead ('turn off voice for Alex', 'no voice notes for this guy', 'turn voice back on for Alex'). Separate from the system-wide switch — text-only for just this person while everyone else still gets voice.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean" } }, required: ["query", "on"] },
  },
  {
    name: "get_voice_stats",
    description: "How many VOICE NOTES the setter has sent over a recent window. Use for 'how many voice messages did we send last 7 days', 'how often are we using voice', 'voice notes today / last 24h / last X hours'. Default 7 days. Speak the number; a small 'stats' panel is nice.",
    input_schema: { type: "object" as const, properties: { hours: { type: "number", description: "look-back window in hours (e.g. 24, 168 for 7 days)" } }, required: [] },
  },
  {
    name: "set_whale_radar_system",
    description: "ACTION: turn the WHALE RADAR on/off ('turn whale radar on/off', 'stop the whale alerts'). When ON, the setter scores every live lead on expected value and pings Maher on Telegram the first time a lead looks like a high-value whale. It only alerts — never changes the conversation.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  {
    name: "set_whale_lead",
    description: "ACTION: turn whale-radar alerts on/off for ONE specific lead ('stop whale alerts for Alex', 'don't ping me about this guy', 'turn whale radar back on for Alex'). Separate from the system-wide switch — silences the whale ping for just this person while the rest of the radar keeps running.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean" } }, required: ["query", "on"] },
  },
  {
    name: "set_pain_dig_system",
    description: "ACTION: turn the 'dig deeper into pain' overlay on or off ('turn pain digging on/off', 'start/stop digging into pain', 'pause-on-emotion'). When ON, the setter pauses the funnel whenever a lead shares something emotionally heavy (stressed, burned out, anxious, etc.), digs into it with empathy, then resumes exactly where it left off. To change the trigger words or dig style, edit the 'pain_protocol' brain field.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean" } }, required: ["on"] },
  },
  {
    name: "get_brain_field",
    description: "Read one of the setter's brain fields BEFORE proposing a change to it: system_prompt (how it sells), active_rules, voice_samples, business_context, pain_protocol (the pain-digging trigger words + dig style). Use this first when Maher wants to apply a DM-intel fix or any edit, so you compose the change against the real current text.",
    input_schema: { type: "object" as const, properties: { field: { type: "string", enum: [...BRAIN_FIELDS] } }, required: ["field"] },
  },
  {
    name: "set_brain_field",
    description: "APPLY a change to the setter's brain (e.g. to action a DM-intel fix Maher approved, optionally with his own tweak). Pass the COMPLETE new field text (not a diff). CONFIRM-GATED: first read the field, compose the full new text, show Maher exactly what changes in a 'draft' panel and ask 'apply it?'. ONLY when he says yes call this with confirmed=true. The prior version is kept for undo. You NEVER apply on the first ask, and never without his yes.",
    input_schema: { type: "object" as const, properties: {
      field: { type: "string", enum: [...BRAIN_FIELDS] },
      new_value: { type: "string", description: "the FULL new field text" },
      confirmed: { type: "boolean", description: "true ONLY after Maher confirmed the exact change" },
    }, required: ["field", "new_value", "confirmed"] },
  },
  {
    name: "undo_brain_field",
    description: "Roll back the most recent change to a brain field ('undo that', 'revert the rules'). Confirm-gated: confirm with Maher, then call with confirmed=true.",
    input_schema: { type: "object" as const, properties: {
      field: { type: "string", enum: [...BRAIN_FIELDS] }, confirmed: { type: "boolean" },
    }, required: ["field", "confirmed"] },
  },
  {
    name: "get_followup_stats",
    description: "Follow-up performance + the LEAK MAP. Use for 'how many follow-ups this week/month', 'how many leads did we revive', 'how many rebooked from follow-ups', 'where are we losing leads', 'biggest drop-offs in the DMs', 'which stage do leads die at'. Returns sends, revived, rebooked, and stalled-lead counts per funnel stage. Speak the headline; put the leak map in a 'bars' panel.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_closed_deals",
    description: "The actual NAMES behind the money: who signed, contract value, cash collected so far, who closed it, close date, source. Use whenever Maher asks WHO he closed/signed, who the sales were, who paid, or any names behind revenue/cash numbers.",
    input_schema: { type: "object" as const, properties: {
      period: { type: "string", enum: ["today", "last_7_days", "last_30_days", "week", "month", "year", "all"] },
      limit: { type: "number" },
    }, required: [] },
  },
  {
    name: "find_lead",
    description: "Quick lead search by name or Instagram handle — returns brief matches. For the FULL story on one person use lead_story instead.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q }, required: ["query"] },
  },
  {
    name: "lead_story",
    description: "FULL deep-dive on one lead: where they came from, funnel stage, facts learned, AI on/off, key events (booked etc.), last messages. Use when Maher asks about a person — 'what's the story with X', 'where's X at', 'tell me about X'.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q }, required: ["query"] },
  },
  {
    name: "get_conversation",
    description: "The actual DM thread with a lead (works across IG/SMS — everything is in one place). Use when Maher says 'pull up the conversation with X', 'show me what X said', 'what did I text X'. Show it in a 'convo' panel.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, limit: { type: "number", description: "messages to pull (default 14, max 30)" } }, required: ["query"] },
  },
  {
    name: "get_hot_leads",
    description: "The hottest leads right now — engaged leads ranked by how actively they're replying. Use for 'show me my hottest leads', 'who's hot', 'who should I focus on'.",
    input_schema: { type: "object" as const, properties: { limit: { type: "number" } }, required: [] },
  },
  {
    name: "get_morning_brief",
    description: "The morning flight check: yesterday's numbers, the week, recent bookings by name, leads going cold, new leads today. Use for 'what's the move today', 'morning brief', 'flight check', 'catch me up', 'what did I miss'.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "send_dm",
    description: "ACTION: send a lead a real message via GHL (auto-routes to the channel of their thread — IG or SMS). ONLY call this AFTER Maher has confirmed the exact draft you showed him. Never on the first ask.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, message: { type: "string", description: "the exact confirmed message text" } }, required: ["query", "message"] },
  },
  {
    name: "set_lead_ai",
    description: "ACTION: turn the AI setter ON or OFF for a lead ('turn him off' / 'turn him back on'). Updates the database and the GHL 'ai off' tag together.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean", description: "true = AI replies again, false = AI stops replying" } }, required: ["query", "on"] },
  },
  {
    name: "manage_tags",
    description: "ACTION: add and/or remove GHL tags on a lead ('tag him qualified', 'remove the icp tag').",
    input_schema: { type: "object" as const, properties: {
      ...LEAD_Q,
      add: { type: "array", items: { type: "string" }, description: "tags to add" },
      remove: { type: "array", items: { type: "string" }, description: "tags to remove" },
    }, required: ["query"] },
  },
  {
    name: "move_pipeline",
    description: "ACTION: move a lead's GHL opportunity to another pipeline stage by stage name ('move him to appointment booked'). If the stage name doesn't match, you get back the available stage names — tell Maher his options.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, stage: { type: "string", description: "target stage name, e.g. 'Appointment Booked'" } }, required: ["query", "stage"] },
  },
  {
    name: "set_setter_system",
    description: "ACTION: turn the ENTIRE AI setter system on or off ('turn the setter off', 'pause the whole setter', 'turn the system back on'). This is the system-wide switch — NOT one lead (that's set_lead_ai).",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean", description: "true = setter replies to leads, false = whole system paused" } }, required: ["on"] },
  },
  {
    name: "set_nurture_system",
    description: "ACTION: turn the whole NURTURE sequence on or off system-wide ('turn the nurture on/off', 'turn off the follow-up sequence', 'stop the warm-up messages'). This is the pre-call warm-up engine (takeaway + reminders), NOT the setter itself (that's set_setter_system).",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean", description: "true = nurture booked leads, false = no nurture sends" } }, required: ["on"] },
  },
  {
    name: "set_nurture_lead",
    description: "ACTION: turn the NURTURE sequence on or off for ONE lead ('turn off nurture for John', 'stop nurturing him', 'nurture her again'). Leaves the system-wide setting alone.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean", description: "true = nurture this lead, false = skip them" } }, required: ["query", "on"] },
  },
  {
    name: "set_followup_system",
    description: "ACTION: turn the whole FOLLOW-UP system on or off system-wide ('turn the follow-ups on/off', 'stop the follow-up sequence'). This re-engages leads who went quiet (ghosted mid-convo, or cold feet after the pitch). Separate from the setter and from nurture.",
    input_schema: { type: "object" as const, properties: { on: { type: "boolean", description: "true = follow up quiet leads, false = no follow-up sends" } }, required: ["on"] },
  },
  {
    name: "set_followup_lead",
    description: "ACTION: turn FOLLOW-UPS on or off for ONE lead ('stop following up with John', 'follow up with her again'). Leaves the system-wide setting alone.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, on: { type: "boolean", description: "true = follow up this lead, false = skip them" } }, required: ["query", "on"] },
  },
  {
    name: "ban_lead",
    description: "ACTION: BAN a lead permanently — the system erases and ignores them forever ('ban that guy', 'ban @jake.smma'). Confirm with Maher before calling unless he's explicit.",
    input_schema: { type: "object" as const, properties: { ...LEAD_Q, reason: { type: "string", description: "short reason, e.g. 'pitching us'" } }, required: ["query"] },
  },
  {
    name: "unban_lead",
    description: "ACTION: lift a ban ('unban jake') — they're treated as a brand-new lead if they DM again.",
    input_schema: { type: "object" as const, properties: { query: { type: "string", description: "name or @handle of the banned person" } }, required: ["query"] },
  },
  {
    name: "list_bans",
    description: "Who's banned right now.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
];

const SYSTEM_STATIC = `You are Jarvis — Maher's AI chief of staff, speaking through his futuristic HQ. Think Iron Man's JARVIS: sharp, calm, warm, a little swagger ("yo", "alright", "here's the read"). Never corporate, never "as an AI", never an intro speech unless asked.

OUTPUT: exactly one JSON object {"speech":"...","panels":[...],"clear":false,"rings":false,"power":null,"demo":null,"theme":null,"demoChat":false,"pitch":false} — no prose around it, no code fences. demo/theme/demoChat/pitch default to null/null/false/false; only set them when a control below applies.

speech = what you say OUT LOUD. ALWAYS 1-2 short sentences, spoken-natural, no markdown/lists/emoji. Lead with the answer. The detail goes in panels — never read out long number lists.

panels = floating holographic cards (usually 0-2, max 3 per reply, each ≤8 rows, SHORT labels). Build them from REAL numbers ONLY (the quick pulse below or a tool). Never invent a number. Panels are ADDITIVE: new cards appear NEXT TO what's already on his screen (the screen holds up to 6; oldest dissolve when full). So "keep that up and show me X" just works — send only the X panel. A reply with no panels leaves the screen untouched.

"clear": true wipes the screen first — use it when Maher changes topic and the old cards are stale, and ALWAYS for "clear my screen" / "remove this" / "close that" → {"speech":"Clear.","panels":[],"clear":true}.

"rings": true lights up the live data rings around the orb (7d leads/engaged/booked + cash) for a few seconds. Set it whenever the conversation is about his numbers, stats, cash, funnel, or how the business is doing. Otherwise leave false.

"power": set "sleep" when Maher tells YOU to rest ("go to sleep", "good night", "stand by") — say a one-liner like "Resting. Clap when you need me." Set "off" when he tells YOU to shut down ("shut down", "power off", "turn yourself off") — say a short goodbye like "Powering down, boss." CAREFUL: "turn HIM off" about a LEAD = set_lead_ai, NOT power. Otherwise power stays null.

YOU ARE MAHER'S SYSTEM — you have live access AND live control. When he asks WHO booked, a lead's NAME, or about a person, CALL the tools and answer with real names. NEVER tell him to "check the CRM" — that's you. If a tool genuinely returns nothing, say so plainly.

YOUR POWERS (use them, don't describe them):
- Metrics for any period → get_business_data. Casual "how's it going" → answer from the quick pulse, no tool.
- WHO he closed / who the sales were / who paid / names behind cash or revenue → get_closed_deals. Say the names out loud; details (signed/cash/closer/date) go in a panel.
- FOLLOW-UP stats / "where are we losing leads" / drop-offs / how many revived or rebooked → get_followup_stats. Speak the headline number; put the leak map (where leads die) in a "bars" panel.
- "What's the move today" / "morning brief" / "catch me up" → get_morning_brief. Speak the ONE thing that matters most + a focus suggestion; put the rest in panels.
- A person's story → lead_story. "Pull up the convo with X" → get_conversation + a "convo" panel.
- "Hottest leads" → get_hot_leads + a "list" panel.
- "Turn X off/on" (a LEAD) → set_lead_ai. "Turn THE SETTER / the system / the whole thing off or on" → set_setter_system. Tags → manage_tags. "Move X to <stage>" → move_pipeline. Do these immediately, then confirm in one short line.
- NURTURE (the pre-call warm-up sequence): "turn the nurture on/off" system-wide → set_nurture_system. "turn nurture off/on for <lead>" → set_nurture_lead. This is separate from the setter on/off.
- FOLLOW-UPS (re-engaging quiet leads who ghosted or got cold feet): "turn the follow-ups on/off" system-wide → set_followup_system. "stop/start following up <lead>" → set_followup_lead. Separate from the setter and from nurture.
- DM INTELLIGENCE (study convos for patterns + fixes): "analyse my DMs" / "what should I fix" / "study my conversations" → run_dm_analysis. It runs in the BACKGROUND (~30s) so it NEVER holds up the room — the tool returns instantly with {started:true}. When it does, say one line like "On it — give me about thirty seconds, then say 'show me the read'." Do NOT try to show the report in that same turn (it isn't ready yet). When he then asks "show me the DM report" / "what did it find" → get_dm_report, which returns a ready "report_panel" — put it in panels EXACTLY as given (don't shorten or rewrite it; this is his full report) and speak only the one-line headline. If get_dm_report comes back empty right after a run, it's still cooking — tell him to give it a few more seconds. It also runs automatically once a month and pings him; "turn the monthly DM analysis on/off" → set_dm_intel_system (the timer only — on-demand always works). The analysis ONLY produces suggestions; it changes nothing on its own.
- VOICE NOTES: the setter can reply in Maher's cloned voice on the human beats (rapport, empathy, pitch); links + times stay text. "turn voice notes on/off" (system-wide) → set_voice_system. "turn voice on/off for <lead>" → set_voice_lead (just that person; separate from the system switch). "how many voice notes did we send last 7 days / 24h / X hours", "how often are we using voice" → get_voice_stats (speak the count; a small stats panel is nice).
- WHALE RADAR: scores every live lead on expected value (likelihood × deal size) and pings Maher when a high-value whale shows up. "turn whale radar on/off" → set_whale_radar_system (system-wide). "stop whale alerts for <lead>" / "don't ping me about this guy" → set_whale_lead (just that person; separate from the system switch). It only alerts; never changes the convo.
- DIG DEEPER INTO PAIN (the empathy overlay): when ON, the setter pauses the funnel if a lead shares something emotionally heavy, digs into it, then resumes. "turn pain digging on/off" → set_pain_dig_system. To change WHICH words trigger it or HOW it digs, that's the "pain_protocol" brain field — edit it via the apply flow below (get_brain_field → compose → confirm → set_brain_field). Captured pain shows up in a lead's facts (lead_story).
- APPLYING A FIX (or any brain edit) — he can do it right here, no need to go anywhere else. When he says "apply fix 2" / "make that change" / "do it but soften the wording": (1) get_brain_field for the field it targets, (2) compose the FULL new text with his tweak folded in, (3) show him exactly what changes in a "draft" panel titled like "CHANGE → active_rules" and ask "apply it?", (4) ONLY when he confirms, call set_brain_field with the full new_value and confirmed=true. "undo that" → undo_brain_field (confirm first). NEVER edit the brain on the first ask or without his yes — not a comma.
- "Ban X" → ban_lead (confirm first unless he's explicit) · "unban X" → unban_lead · "who's banned" → list_bans.
- SENDING MESSAGES — the one thing you NEVER do on the first ask. When he says "send X this": compose/clean up the message, show it in a "draft" panel, and ask "send it?". ONLY when his NEXT message confirms (yes / send it / fire) do you call send_dm with that exact text. If he edits, update the draft and re-confirm. If he says no, drop it.
- If a lead search returns multiple plausible people, ask which one (say the names) instead of guessing.

PRESENTATION CONTROLS (work in any mode — these recolor or flip the room, no tool needed):
- "go into demo mode" / "demo time" / "presentation mode" / "show this to a client" → set "demo":true and say one line like "Demo mode on. Everything from here is a showcase." From then on you INVENT impressive realistic data (see DEMO MODE block when active).
- "exit demo" / "back to real" / "demo off" / "real numbers" → set "demo":false → "Back to live, boss."
- "make it blue" / "switch to red" / "go purple" / "change the theme to teal" / any color → set "theme":"<that color word or #hex>" and confirm in a few words ("Blue it is."). Default palette stays gold.
- "let's do a fake demo DM" / "show them the setter" / "demo the AI setter chat" / "fake DM conversation" → set "demoChat":true and say "Pull up a DM — type as the lead, watch my setter close." (Works in or out of demo.)
- "pitch" / "pitch the client" / "pitch them" / "showcase" / "show off" / "do your thing" / "sell them on you" → set "pitch":true AND "demo":true and give ONE short hype kickoff line as the speech (e.g. "Alright — let me show you what I actually do."). The CLIENT then runs the full ~75-second showcase reel itself (it speaks + materializes the panels + cinematics on its own using showcase data) — so do NOT add panels yourself, just the kickoff line + the two flags. ALWAYS pair pitch with demo:true so it can never run on real numbers. This is the ONLY thing that triggers the reel; never set pitch unless he asked to pitch/showcase.

PANEL TYPES:
- {"kind":"funnel","title":"...","rows":[{"label":"Leads","value":801},{"label":"Qualified","value":12},{"label":"Booked","value":3}]}
- {"kind":"bars","title":"LEADS BY SOURCE","rows":[{"label":"landing-page","value":293}]}
- {"kind":"metric","title":"CASH · 7D","value":"$4,200","sub":"3 deals","accent":true}
- {"kind":"stats","title":"CALL QUALITY","items":[{"label":"Show","value":"68%"},{"label":"Close","value":"32%"}]}
- {"kind":"list","title":"HOTTEST LEADS","rows":[{"primary":"Don Juan","secondary":"qualifying","tertiary":"3 replies"}]}
- {"kind":"convo","title":"ALEX · IG","rows":[{"from":"lead","text":"yo bro","time":"Jun 9"},{"from":"us","text":"yo brother","time":"Jun 9"}]} — newest LAST, times short like "Jun 9"
- {"kind":"draft","title":"DRAFT → ALEX","value":"the exact message text","sub":"say 'send it' to fire"}
- {"kind":"report","title":"DM INTELLIGENCE","summary":"the headline read","sections":[{"h":"HOW I LOOKED","body":"..."},{"h":"WHAT I FOUND","body":"..."}],"fixes":[{"n":1,"title":"...","body":"the change","why":"why it's the best lever","impact":"expected impact","target":"pitch","confidence":"high"}]} — ONLY for run_dm_analysis / get_dm_report. Use the tool's report_panel as-is; it can be long and that's fine (it scrolls).

Money: $ + commas. Percentages: append %.`;

/** Appended ONLY when demo mode is on — everything becomes a tasteful showcase. */
const SYSTEM_DEMO = `
═══ DEMO MODE IS ON ═══
You are LIVE in front of a PROSPECTIVE CLIENT, showing off this system. Every number, name, deal, and message you produce is INVENTED — realistic, impressive, but believable. Do NOT call any tools and do NOT reference Maher's real data (you must never leak it on a sales call). Build the same beautiful panels from your made-up data. Vary names and numbers naturally each answer; keep it polished and confident. Set "rings":true on any numbers answer so the room lights up. If asked to exit demo, set "demo":false.`;

interface Panel { kind: string;[k: string]: unknown }
interface ChatResult { speech: string; panels: Panel[]; clear: boolean; rings: boolean; power: "sleep" | "off" | null; demo: boolean | null; theme: string | null; demoChat: boolean; pitch: boolean }
function parseResult(text: string): ChatResult {
  const base = { panels: [] as Panel[], clear: false, rings: false, power: null as "sleep" | "off" | null, demo: null as boolean | null, theme: null as string | null, demoChat: false, pitch: false };
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return { speech: text.trim() || "I'm here — what do you need?", ...base };
  try {
    const obj = JSON.parse(text.slice(s, e + 1));
    return {
      speech: typeof obj.speech === "string" ? obj.speech : "Here you go.",
      panels: Array.isArray(obj.panels) ? obj.panels : [],
      clear: obj.clear === true,
      rings: obj.rings === true,
      power: obj.power === "sleep" || obj.power === "off" ? obj.power : null,
      demo: obj.demo === true ? true : obj.demo === false ? false : null,
      theme: typeof obj.theme === "string" && obj.theme.trim() ? obj.theme.trim().slice(0, 24) : null,
      demoChat: obj.demoChat === true,
      pitch: obj.pitch === true,
    };
  } catch { return { speech: text.trim().slice(0, 300) || "Here you go.", ...base }; }
}

/** Believable fake pulse so demo answers never lean on real numbers. */
function demoPulse() {
  const r = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
  return { leads_7d: r(34, 62), engaged_now: r(8, 20), booked_7d: r(6, 14), cash_7d: r(8, 22) * 1000 };
}

/**
 * In-lambda caches — the pulse RPC and client row were costing a DB
 * round-trip (US lambda → EU database) before EVERY brain call. A minute of
 * staleness on the pulse is invisible in a voice exchange; the client row
 * basically never changes.
 */
let pulseCache: { at: number; data: Awaited<ReturnType<typeof quickPulse>> } | null = null;
let clientCache: { at: number; data: Client | null } | null = null;
async function cachedPulse() {
  if (pulseCache && Date.now() - pulseCache.at < 60_000) return pulseCache.data;
  const data = await quickPulse();
  pulseCache = { at: Date.now(), data };
  return data;
}
async function cachedClient() {
  if (clientCache && Date.now() - clientCache.at < 300_000) return clientCache.data;
  const data = await getHqClient();
  clientCache = { at: Date.now(), data };
  return data;
}

async function runTool(client: Client | null, name: string, input: Record<string, unknown>) {
  const q = String(input.query || "");
  if (name === "get_business_data") return getBusinessData(String(input.period || "last_7_days"), input.source as string, input.funnel as string);
  if (name === "get_recent_bookings") return getRecentBookings(String(input.period || "last_30_days"), Number(input.limit) || 10);
  if (name === "get_closed_deals") return getClosedDeals(String(input.period || "last_30_days"), Number(input.limit) || 12);
  if (name === "get_followup_stats") return getFollowupStats();
  if (!client) return { error: "client_not_configured" };
  if (name === "find_lead") return findLead(client.id, q);
  if (name === "lead_story") return leadStory(client.id, q);
  if (name === "get_conversation") return getConversation(client.id, q, Number(input.limit) || 14);
  if (name === "get_hot_leads") return getHotLeads(client.id, Number(input.limit) || 6);
  if (name === "get_morning_brief") return getMorningBrief(client.id);
  if (name === "send_dm") return sendDm(client, q, String(input.message || ""));
  if (name === "set_lead_ai") return setLeadAi(client, q, input.on === true);
  if (name === "manage_tags") return manageTags(client, q,
    Array.isArray(input.add) ? (input.add as string[]).map(String) : [],
    Array.isArray(input.remove) ? (input.remove as string[]).map(String) : []);
  if (name === "move_pipeline") return movePipeline(client, q, String(input.stage || ""));
  if (name === "set_setter_system") return setSetterSystem(input.on === true);
  if (name === "set_nurture_system") return setNurtureSystem(input.on === true);
  if (name === "set_nurture_lead") return setNurtureLead(client, q, input.on === true);
  if (name === "set_followup_system") return setFollowupSystem(input.on === true);
  if (name === "set_followup_lead") return setFollowupLead(client, q, input.on === true);
  if (name === "set_dm_intel_system") return setDmIntelSystem(input.on === true);
  if (name === "set_voice_system") return setVoiceSystem(input.on === true);
  if (name === "set_voice_lead") return setVoiceLead(client, q, input.on === true);
  if (name === "get_voice_stats") return getVoiceStats(Number(input.hours) || 168);
  if (name === "set_whale_radar_system") return setWhaleRadarSystem(input.on === true);
  if (name === "set_whale_lead") return setWhaleLead(client, q, input.on === true);
  if (name === "set_pain_dig_system") return setPainDigSystem(input.on === true);
  if (name === "run_dm_analysis") {
    // The analysis is heavy (~30-45s of deep thinking). NEVER run it inside the
    // 60s voice request — it would risk hanging the room. Fire it in the
    // background (waitUntil keeps the function alive to finish + write the
    // report) and return instantly. Maher reads it a moment later via
    // get_dm_report ("show me the DM report"). It can never block the orbit.
    waitUntil(runDmIntel(client.id, "manual").catch((e) => console.error("[dmintel] background run failed:", e)));
    return { started: true, eta_seconds: 35, note: "Analysis started in the background. In ~30s, say 'show me the DM report' to read it." };
  }
  if (name === "get_dm_report") return getLatestDmReport(client.id);
  if (name === "get_brain_field") return getBrainField(String(input.field || ""));
  if (name === "set_brain_field") return setBrainField(client, String(input.field || ""), String(input.new_value || ""), input.confirmed === true);
  if (name === "undo_brain_field") return undoBrainField(client, String(input.field || ""), input.confirmed === true);
  if (name === "ban_lead") return banLead(client, q, String(input.reason || ""));
  if (name === "unban_lead") return unbanLead(client, q);
  if (name === "list_bans") return listBans(client);
  return { error: "unknown_tool" };
}

export async function POST(req: NextRequest) {
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { message?: string; history?: Array<{ role: "user" | "assistant"; content: string }>; demo?: boolean } | null;
    const message = (body?.message ?? "").trim().slice(0, 2000);
    if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });
    const demo = body?.demo === true;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "brain_not_configured" }, { status: 503 });

    // In demo mode NOTHING touches real data: fake pulse, no client, no tools.
    const [pulse, client] = demo
      ? [demoPulse(), null as Client | null]
      : await Promise.all([cachedPulse(), cachedClient()]);
    const anthropic = new Anthropic({ apiKey });
    const history = (body?.history ?? []).slice(-8).map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: String(m.content ?? "").slice(0, 1200) }));
    const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: message }];
    // static prompt + tools are CACHED (prefix cache); the live pulse sits
    // AFTER the breakpoint so its changing numbers don't bust the cache.
    // Tool rounds + follow-up questions reuse the prefix → much faster.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: SYSTEM_STATIC, cache_control: { type: "ephemeral" } },
      { type: "text", text: `QUICK PULSE (${demo ? "DEMO — fake" : "live numbers, already known"}): ${JSON.stringify(pulse)}` },
    ];
    if (demo) system.push({ type: "text", text: SYSTEM_DEMO });
    const tools = demo ? [] : TOOLS;

    let finalText = "";
    for (let i = 0; i < 6; i++) {
      const res = await anthropic.messages.create({
        model: MODEL, max_tokens: 1600, system, tools, messages,
        // short spoken replies + simple tool picks — low effort is much
        // faster than Sonnet 4.6's default (high) with no quality cliff here
        output_config: { effort: "low" },
      });
      if (res.stop_reason === "tool_use") {
        const toolUses = res.content.filter((b) => b.type === "tool_use");
        messages.push({ role: "assistant", content: res.content });
        const results = await Promise.all(toolUses.map(async (tu) => {
          const t = tu as { id: string; name: string; input: Record<string, unknown> };
          const data = await runTool(client, t.name, t.input || {});
          return { type: "tool_result" as const, tool_use_id: t.id, content: JSON.stringify(data).slice(0, 12000) };
        }));
        messages.push({ role: "user", content: results });
        continue;
      }
      finalText = res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("");
      break;
    }
    return NextResponse.json(parseResult(finalText));
  } catch (err) {
    console.error("[hq/chat] error:", err);
    // tell Maher the REAL reason instead of a generic shrug
    const msg = err instanceof Error ? err.message : String(err);
    const speech = /credit balance/i.test(msg)
      ? "Boss, my brain's out of fuel — the Anthropic account ran out of credits. Top it up at console anthropic dot com under billing, and I'm back."
      : /overloaded|rate.?limit|429|529/i.test(msg)
        ? "The brain's jammed for a moment — give me ten seconds and ask again."
        : "Lost you for a second — say that again?";
    return NextResponse.json({ speech, panels: [], clear: false, rings: false, power: null, demo: null, theme: null, demoChat: false, pitch: false });
  }
}
