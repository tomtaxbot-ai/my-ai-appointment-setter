/**
 * GHL INBOUND WEBHOOK (multi-tenant routing)
 * -------------------------------------------
 * GHL hits this endpoint whenever a lead sends a DM/SMS/WhatsApp message.
 *
 * Multi-tenant routing strategy:
 *   We look up the client by `locationId` in the payload. Each client's
 *   GHL sub-account has a unique locationId — we store it on the
 *   `clients.ghl_location_id` column.
 *
 * Payload field map (from real captured GHL payloads):
 *   contactId   = body.customData?.contactId || body.contact_id
 *   locationId  = body.location?.id || body.customData?.locationId
 *   messageText = body.message?.body            (NEVER a custom field)
 *   igSenderId  = body.contact?.attributionSource?.igSid
 *               || body.contact?.lastAttributionSource?.igSid
 *
 * Flow:
 *   1. Log raw body + headers to webhook_debug_logs (BEFORE any validation)
 *   2. Verify webhook secret
 *   3. Extract locationId, contactId, message.body from payload
 *   4. If message.body is empty/missing (non-text IG: type 18 image shares,
 *      story replies, reactions) → return 200 and skip, no AI
 *   5. Look up the client by locationId
 *   6. Find or create the lead by contactId (fall back to igSenderId only
 *      if contactId is missing)
 *   7. Save lead message
 *   8. Return 200 immediately (don't make GHL wait)
 *   9. In background: generate AI reply → save → send via GHL
 */

import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  getClientByGHLLocation,
  findOrCreateLead,
  getLeadByContact,
  getRecentMessages,
  getLatestLeadMessage,
  saveMessage,
  setMessageGhlId,
  messageExistsByGhlId,
  captureLeadSource,
  setBookingMethod,
  updateLeadStage,
  updateLeadLanguage,
  acquireReplyLock,
  releaseReplyLock,
  logEvent,
  logAIDecision,
  eventExists,
  countAiMessagesSince,
  countClientAiMessagesSince,
  recentEventExists,
  supabase,
  type DbMessage,
} from "@/lib/supabase";
import {
  deriveLeadSource,
  hasSourceSignal,
  tagBookingLinks,
  resolveBookingMethod,
  type AttributionSource,
} from "@/lib/sourcing";
import { generateReply, PRODUCTION_MODEL } from "@/lib/brain";
import {
  sendGHLMixedSequence,
  getFreeSlots,
  updateContactEmail,
  deleteContact,
} from "@/lib/ghl";
import { findActiveBan } from "@/lib/bans";
import { resolveIncomingMedia } from "@/lib/media";
import {
  runFirstContactScreener,
  runOngoingTagging,
  pauseLead,
} from "@/lib/screener";
import { resolveConversationLanguage } from "@/lib/language";
import { resolveStage, parseStages } from "@/lib/stages";
import { painDigInstruction, painProtocolFor } from "@/lib/paindig";
import { makeVoiceClip, voiceEligible, voiceActive, voiceIdForLang, VOICE_INSTRUCTION, VOICE_MARKER_RE } from "@/lib/voice";
import { recordVideoLinkSent, flushNurtureDue, VIDEO_LINK } from "@/lib/nurture";
import { syncPipelineFunnel, syncPipelineDisqualified } from "@/lib/pipeline-sync";
import { isRepeatReply } from "@/lib/dedup";
import { countryToTimezone } from "@/lib/timezones";
import { sendTelegramPing, ghlContactLink } from "@/lib/telegram";
import { type Message, type StageContext } from "@/lib/prompts/master";

interface GHLAttributionSource {
  igSid?: string;
  [key: string]: unknown;
}

interface GHLWebhookPayload {
  type?: string | number;
  direction?: "inbound" | "outbound";

  // Real GHL payload locations for the IDs we care about
  contact_id?: string;
  customData?: {
    contactId?: string;
    locationId?: string;
    [key: string]: unknown;
  };
  location?: {
    id?: string;
    name?: string;
  };
  message?: {
    id?: string;
    body?: string;
    type?: string | number;
    direction?: string;
    status?: string;
  };
  contact?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
    instagramHandle?: string;
    email?: string;
    phone?: string;
    attributionSource?: GHLAttributionSource; // FIRST touch
    lastAttributionSource?: GHLAttributionSource; // LAST touch
  };

  // Comma-separated GHL contact tags (e.g. "jarvis, lead"). Used as an
  // operator-controlled on/off switch: remove the trigger tag to disengage.
  tags?: string;

  // Native top-level contact fields (used only for display name)
  first_name?: string;
  last_name?: string;

  // Outbound human-send signals (Phase 4): a manual send from a GHL user.
  userId?: string;
  user?: { id?: string; name?: string };

  // Appointment-booked signal (Phase 3, best-effort detection).
  appointment?: Record<string, unknown>;
  calendar?: Record<string, unknown>;
}

// Tags that mean "the AI must NOT handle this contact". You ADD one of these
// to a contact in GHL to disengage the AI (remove it to re-engage). We use an
// opt-OUT tag (not an opt-in one) because the workflow re-adds the "jarvis"
// tag on every inbound message, so a tag you remove would just come back.
const STOP_TAGS = [
  "ai off", "ai-off", "aioff", "stop ai", "stop-ai", "stopai",
  "do not contact", "dnc", "human", "handover", "no ai",
];

/** True if the comma-separated GHL tag string contains any stop tag. */
function hasStopTag(tags: string | undefined): boolean {
  if (!tags) return false;
  const set = tags.split(",").map((t) => t.trim().toLowerCase());
  return STOP_TAGS.some((stop) => set.includes(stop));
}

// The QUIET WINDOW the reply pipeline waits before answering, to coalesce a
// burst of rapid lead messages into a SINGLE reply. Each inbound DM spawns its
// own background invocation; after this wait, only the invocation still holding
// the newest lead message proceeds (the others yield), so the lead gets ONE
// reply once they pause. Set to 12s so normal "texting in bursts" (messages a
// few seconds apart) is gathered into one answer; a genuinely separate message
// minutes later still gets its own reply. The owner can override this with
// clients.reply_delay_min/max_seconds (set from Jarvis); see replyDelayMs().
const QUIET_WINDOW_MS = 6_000;

// How long a per-lead reply lock stays valid before it's considered stale and
// can be re-taken. Kept WELL above maxDuration (60s) so a still-running
// invocation never has its lock stolen, while a crashed one self-heals.
const REPLY_LOCK_TTL_MS = 120_000;

// Hard platform cap on the configurable delay: the whole invocation
// (delay + generation + GHL sends) must finish inside maxDuration (60s on
// Vercel Hobby), so the wait itself may never exceed this.
const MAX_REPLY_DELAY_MS = 30_000;

// Floor on ANY reply delay: even if the owner configures 0/0, never wait
// less than this before replying. The wait is what coalesces a lead's burst
// ("yes bro" ... "Exactly." 10s later) into ONE reply — see the freshness
// check in generateAndSendReply — so it must never collapse toward zero.
const MIN_REPLY_DELAY_MS = 8_000;

// Outbound circuit breakers (anti-ban): ceilings on AI send volume that only
// catch a RUNAWAY, not normal high-volume setting. On 2026-06-08 the setter
// sent 116 DMs to ONE lead inside 40 minutes — a marathon loop that gets an
// IG account flagged. These caps are set well above real conversation pace
// (no human gets ~100 messages/hour in a real back-and-forth) so booking
// throughput is untouched; they exist purely to halt a bug like that one.
// When a ceiling is hit the reply is HELD, an event is logged, and the owner
// is pinged once per episode; the lead gets their next reply once the rolling
// hour clears.
const MAX_AI_MSGS_PER_LEAD_PER_HOUR = 100;
const MAX_AI_MSGS_PER_CLIENT_PER_HOUR = 320;

// Max DM bubbles per reply. The model splits replies into short bubbles with
// [[SPLIT]]; anything past this is merged into the final bubble instead of
// stacking a 6-7 message volley (production hit runs of 7 in a row).
const MAX_BUBBLES_PER_REPLY = 4;

// ── Late-straggler judgment ("leave it on read") ──
// A lead message that lands shortly AFTER our reply already went out is often
// just the tail end of their previous thought ("yes bro" … our reply sends …
// "exactly" 30s later). A human doesn't robotically answer every such text —
// usually the reply that just went out already covers it. When the newest lead
// message arrived within this window of our last send, the model is given
// explicit permission to judge it and answer with the NO_REPLY token to stay
// silent. Outside the window it's a normal message and always gets a reply.
const LATE_FOLLOW_ON_WINDOW_MS = 180_000;

// Whale radar: only ping the owner when a lead's expected-value score is this
// high — keeps it rare (true whales only), once per lead.
const WHALE_THRESHOLD = 80;

const NO_REPLY_TOKEN = "[[NO_REPLY]]";

const LATE_FOLLOW_ON_INSTRUCTION =
  `LATE MESSAGE JUDGMENT: Your previous reply went out only moments before the lead's newest message — their text may just be the tail end of their last thought, possibly sent before they read your reply. Real people don't answer every single text. Compare the lead's newest message against your last reply and decide: ` +
  `(a) If your last reply already answers it, or it adds nothing new and asks nothing (a bare acknowledgment like "ok", "yes bro", "exactly", a thumbs up, or an emoji) — output exactly ${NO_REPLY_TOKEN} and nothing else. No message will be sent; the conversation simply waits for the lead, like leaving it on read. ` +
  `(b) If it asks something real, adds new information, or says something your last reply does NOT cover — reply to it normally, without repeating or rewording anything you already said.`;

/**
 * The wait before replying. When the owner set a delay range on the client
 * (reply_delay_min/max_seconds), pick a random duration inside it — this
 * REPLACES the fixed debounce but still coalesces bursts the same way.
 * When unset (null), keep the original fixed debounce. Always clamped to
 * [MIN_REPLY_DELAY_MS, MAX_REPLY_DELAY_MS].
 */
function replyDelayMs(client: {
  reply_delay_min_seconds: number | null;
  reply_delay_max_seconds: number | null;
}): number {
  const minS = client.reply_delay_min_seconds;
  const maxS = client.reply_delay_max_seconds;
  if (minS == null && maxS == null) return QUIET_WINDOW_MS;
  const lo = Math.max(0, Number(minS ?? maxS ?? 0));
  const hi = Math.max(lo, Number(maxS ?? minS ?? 0));
  const picked = (lo + Math.random() * (hi - lo)) * 1000;
  return Math.min(
    Math.max(Math.round(picked), MIN_REPLY_DELAY_MS),
    MAX_REPLY_DELAY_MS
  );
}

// Max messages fed into the reply generator. Previously the generation path
// capped history at 50 messages, which on long threads dropped the early part
// of the conversation and made the setter re-ask questions it had already
// answered (income/savings/credit twice on a real lead). IG-DM threads are
// small, so we raise the cap far beyond any realistic thread length to pass
// the FULL conversation to the model.
const MAX_GENERATION_HISTORY = 1000;

// Allow the background AI reply (8s debounce + generation + GHL sends with
// typing delays) to finish. The debounce alone needs >=30s of headroom; Vercel
// Hobby supports up to 60s, which we use for maximum margin.
export const maxDuration = 60;

// ── Phase 3: appointment detection + booking_method (best-effort) ──
function looksLikeAppointment(body: GHLWebhookPayload): boolean {
  if (body.appointment || body.calendar) return true;
  const t = typeof body.type === "string" ? body.type.toLowerCase() : "";
  return t.includes("appointment");
}

async function handleAppointmentBooked(body: GHLWebhookPayload) {
  try {
    const contactId = body.customData?.contactId || body.contact_id || body.contact?.id;
    const locationId = body.location?.id || body.customData?.locationId;
    if (!contactId || !locationId)
      return NextResponse.json({ ok: true, skipped: "appointment_missing_ids" });
    const client = await getClientByGHLLocation(locationId);
    if (!client) return NextResponse.json({ ok: true, skipped: "appointment_no_client" });
    const lead = await getLeadByContact(client.id, contactId);
    if (!lead) return NextResponse.json({ ok: true, skipped: "appointment_no_lead" });

    const aiSent = await eventExists(lead.id, "ai_sent_booking_link");
    // existing=null: setBookingMethod itself refuses to overwrite an existing
    // value (incl. 'dialing'), so we only need the candidate here.
    const method = resolveBookingMethod({
      existing: null,
      aiSentLink: aiSent,
      lastAttribution: body.contact?.lastAttributionSource as AttributionSource | undefined,
    });
    await setBookingMethod(lead.id, method);
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "booking_method_set",
      metadata: { method, ai_sent_link: aiSent },
    });
    return NextResponse.json({ ok: true, booking_method: method });
  } catch (e) {
    console.error("[webhook] appointment handler failed:", e);
    return NextResponse.json({ ok: true, skipped: "appointment_error" });
  }
}

// ── Phase 4: record a manual HUMAN outbound message (role='human') ──
async function handleOutboundMessage(body: GHLWebhookPayload) {
  try {
    const text = body.message?.body;
    if (!text || !text.trim())
      return NextResponse.json({ ok: true, skipped: "outbound_no_body" });

    const ghlMsgId = body.message?.id;
    // Our AI sends are stamped with their GHL id → this is the AI's own echo.
    if (ghlMsgId && (await messageExistsByGhlId(ghlMsgId)))
      return NextResponse.json({ ok: true, skipped: "outbound_ai_echo" });

    const contactId = body.customData?.contactId || body.contact_id || body.contact?.id;
    const locationId = body.location?.id || body.customData?.locationId;
    if (!contactId || !locationId)
      return NextResponse.json({ ok: true, skipped: "outbound_missing_ids" });

    const client = await getClientByGHLLocation(locationId);
    if (!client) return NextResponse.json({ ok: true, skipped: "outbound_no_client" });
    const lead = await getLeadByContact(client.id, contactId);
    // Never CREATE a lead from an outbound; only record against an existing one.
    if (!lead) return NextResponse.json({ ok: true, skipped: "outbound_no_lead" });

    // Defense in depth: an AI send whose id wasn't stamped yet would echo with
    // identical text — treat that as the AI, not a human.
    const trimmed = text.trim();
    const recent = await getRecentMessages(lead.id, 6);
    if (recent.some((m) => m.role === "ai" && m.content.trim() === trimmed))
      return NextResponse.json({ ok: true, skipped: "outbound_ai_echo_text" });

    await saveMessage({
      lead_id: lead.id,
      client_id: client.id,
      role: "human",
      content: trimmed,
      ghl_message_id: ghlMsgId,
    });
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "human_message_sent",
      metadata: { ghl_message_id: ghlMsgId ?? null, user_id: body.userId ?? body.user?.id ?? null },
    });
    // If a human manually sent the training video, anchor the nurture off that too.
    if (trimmed.includes(VIDEO_LINK)) await recordVideoLinkSent(client.id, lead);
    return NextResponse.json({ ok: true, recorded: "human" });
  } catch (e) {
    console.error("[webhook] outbound human handler failed:", e);
    return NextResponse.json({ ok: true, skipped: "outbound_error" });
  }
}

export async function POST(req: NextRequest) {
  // --- 1. CAPTURE RAW BODY + HEADERS TO DEBUG TABLE (before any validation) ---
  // We read the raw text first so the debug log is written even when the body
  // is not valid JSON. This must succeed before any validation/short-circuit.
  const rawHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });

  const rawBody = await req.text();

  // Fire-and-forget the raw capture so it lands even if we later bail out.
  supabase
    .from("webhook_debug_logs")
    .insert({
      raw_payload: rawBody,
      raw_headers: rawHeaders,
    })
    .then(
      () => console.log("[webhook] Debug log saved"),
      (err) => console.error("[webhook] Failed to save debug log:", err)
    );

  // --- 2. Parse the payload ---
  let body: GHLWebhookPayload;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  console.log("[webhook] FULL PAYLOAD:", JSON.stringify(body, null, 2));

  // --- 3. Verify webhook secret ---
  const expectedSecret = process.env.GHL_WEBHOOK_SECRET;
  const providedSecret = req.headers.get("x-webhook-secret");
  if (expectedSecret && providedSecret !== expectedSecret) {
    console.warn("[webhook] rejected: bad secret");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Every webhook hit is also a heartbeat for the nurture engine — flush any
  // due proactive touches in the background (no-op unless a client is enabled).
  // This is the active-hours driver; pg_cron covers the quiet hours.
  waitUntil(flushNurtureDue());

  // --- Phase 3: appointment-booked webhook → set booking_method (last touch).
  //     Best-effort: GHL appointment webhooks carry an appointment/calendar
  //     object or a type containing "appointment"; message webhooks never do. ---
  if (looksLikeAppointment(body)) {
    return handleAppointmentBooked(body);
  }

  // --- Phase 4: outbound messages. AI sends are recorded by the reply pipeline
  //     (and stamped with their GHL message id). A manual HUMAN send from GHL
  //     must be recorded as role='human' so we can tell AI- from human-handled
  //     threads. Everything else outbound is ignored. ---
  const direction = body.direction || body.message?.direction || "inbound";
  if (direction === "outbound") {
    return handleOutboundMessage(body);
  }

  // --- 4. Extract fields from the EXACT real payload locations ---
  // Prefer customData.contactId, fall back to root contact_id.
  const contactId = body.customData?.contactId || body.contact_id;
  const locationId = body.location?.id || body.customData?.locationId;
  // Always use message.body. NEVER read from a "Last Inbound Message" field.
  const messageText = body.message?.body;
  const igSenderId =
    body.contact?.attributionSource?.igSid ||
    body.contact?.lastAttributionSource?.igSid;

  // The key we use to identify the lead: contactId, else igSenderId.
  const leadKey = contactId || igSenderId;

  const extracted = {
    messageText: messageText ? `${messageText.substring(0, 50)}...` : "EMPTY",
    contactId: contactId || "EMPTY",
    igSenderId: igSenderId || "EMPTY",
    locationId: locationId || "EMPTY",
    messageType: body.message?.type ?? body.type ?? "unknown",
    direction,
  };
  console.log("[webhook] Extracted:", extracted);

  if (!leadKey) {
    console.warn("[webhook] Missing contactId and igSenderId — cannot identify lead.");
    return NextResponse.json(
      { ok: false, reason: "no_contact_or_ig_sender" },
      { status: 200 }
    );
  }

  if (!locationId) {
    console.warn("[webhook] missing locationId in payload");
    return NextResponse.json(
      { ok: false, reason: "missing_location_id" },
      { status: 200 }
    );
  }

  // --- 6. Look up the client by GHL location ID (the multi-tenant router) ---
  // A transient DB error here must NOT be mistaken for "no client" — that
  // would return 200 and make GHL drop the message permanently. On a real
  // lookup failure we return 503 so the message can be retried/redelivered.
  let client;
  try {
    client = await getClientByGHLLocation(locationId);
  } catch (err) {
    console.error("[webhook] client lookup failed (transient DB error):", err);
    return NextResponse.json(
      { ok: false, reason: "client_lookup_failed", locationId },
      { status: 503 }
    );
  }

  if (!client) {
    console.warn("[webhook] no client found for locationId:", locationId);
    return NextResponse.json({
      ok: true,
      skipped: "no_client_for_location",
      locationId,
    });
  }

  // NOTE: no is_active early-return here. When the setter is globally OFF the
  // inbound message must STILL be recorded (lead + message + events) so the
  // owner can follow up — the reply gate below (after recording) withholds
  // only the automated reply. The old early-return here dropped those DMs.

  if (!client.ghl_api_key) {
    console.error("[webhook] client missing GHL API key:", client.slug);
    return NextResponse.json(
      { error: "Client GHL credentials not configured" },
      { status: 500 }
    );
  }

  // --- Ban gate: a contact Maher has banned must NEVER exist in the system. ---
  // GHL re-creates the contact (new contactId) the moment a banned person DMs
  // again, so we match on the durable Instagram handle / sender id too. This
  // runs BEFORE we create any lead or save any message: we delete the freshly
  // re-created GHL contact, record nothing about them, never reply, never ping.
  const ban = await findActiveBan(client.id, {
    ghl_contact_id: contactId,
    ig_username: body.contact?.instagramHandle,
    ig_sender_id: igSenderId,
  });
  if (ban) {
    console.log("[webhook] banned contact — erasing re-created GHL contact, no AI.");
    if (contactId) {
      const del = await deleteContact(client.ghl_api_key, contactId);
      if (!del.success) {
        console.error("[webhook] ban gate: GHL deleteContact failed:", del.error);
      }
    }
    await logEvent({
      client_id: client.id,
      event_type: "blocked_banned_contact",
      metadata: {
        ban_id: ban.id,
        ghl_contact_id: contactId ?? null,
        ig_username: body.contact?.instagramHandle ?? null,
        ig_sender_id: igSenderId ?? null,
      },
    });
    return NextResponse.json({ ok: true, skipped: "banned", client: client.slug });
  }

  // --- 5. Resolve media messages (voice notes / images) into text. ---
  // IG sends these as "type 18" with an empty body and no media URL, so we call
  // the GHL API to fetch the attachment, then transcribe audio (Groq) or
  // describe images (Claude vision). The result is stored and flows through the
  // pipeline as if the lead had typed it. Text messages skip this entirely.
  let effectiveText = messageText;
  if (!effectiveText || !effectiveText.trim()) {
    try {
      const resolved = await resolveIncomingMedia({
        apiKey: client.ghl_api_key,
        locationId,
        contactId: leadKey,
      });
      if (resolved) {
        effectiveText = resolved;
        console.log("[webhook] media resolved to text:", resolved.substring(0, 80));
      }
    } catch (err) {
      console.error("[webhook] media resolution failed:", err);
    }
  }

  // Still nothing usable (reaction, story reply, share, video, or fetch
  // failed) — return 200 so GHL doesn't retry, and never call the AI.
  if (!effectiveText || !effectiveText.trim()) {
    console.log("[webhook] No usable content (non-text IG event) — skipping, no AI.");
    return NextResponse.json({ ok: true, skipped: "no_message_body" });
  }

  // --- 7 & 8. Find/create the lead and save the incoming message ---
  // These now throw on persistent DB failure. A transient blip here must not
  // silently drop the lead's message, so on failure we return 503 (retryable)
  // rather than acking with 200.
  const firstName = body.contact?.firstName || body.first_name;
  const lastName = body.contact?.lastName || body.last_name;
  const fullName =
    body.contact?.name || [firstName, lastName].filter(Boolean).join(" ") || undefined;

  let lead;
  // The id + created_at of THIS inbound message. The reply debouncer uses it to
  // detect whether a newer lead message arrived during its wait window.
  let inboundMessageId: string | undefined;
  try {
    lead = await findOrCreateLead({
      client_id: client.id,
      ghl_contact_id: leadKey,
      ig_username: body.contact?.instagramHandle,
      full_name: fullName,
    });

    const savedMsg = await saveMessage({
      lead_id: lead!.id,
      client_id: client.id,
      role: "lead",
      content: effectiveText,
      channel: "instagram",
      ghl_message_id: body.message?.id,
    });
    inboundMessageId = savedMsg?.id;
  } catch (err) {
    console.error("[webhook] failed to persist lead/message (transient?):", err);
    return NextResponse.json(
      { ok: false, reason: "persist_failed" },
      { status: 503 }
    );
  }

  await logEvent({
    client_id: client.id,
    lead_id: lead!.id,
    event_type: "lead_message_received",
    metadata: { locationId, used_ig_sender: !contactId && !!igSenderId },
  });

  // --- Phase 1: first-touch source capture (form UTM and/or attribution).
  //     First touch wins — captureLeadSource only writes when src_channel is
  //     still empty, so this is safe to run on every inbound. Best-effort. ---
  try {
    const src = deriveLeadSource({
      customData: body.customData as Record<string, unknown> | undefined,
      firstAttribution: body.contact?.attributionSource as AttributionSource | undefined,
    });
    if (hasSourceSignal(src)) {
      await captureLeadSource(lead!, src, {
        first: body.contact?.attributionSource ?? null,
        last: body.contact?.lastAttributionSource ?? null,
      });
    }
  } catch (e) {
    console.error("[webhook] source capture failed:", e);
  }

  // --- Global kill switch: setter OFF (clients.is_active=false, including a
  //     "pause until"). The lead + message + events above are already saved —
  //     only the automated REPLY is withheld. ---
  if (!client.is_active) {
    console.log("[webhook] setter is OFF — message recorded, reply withheld.");
    await logEvent({
      client_id: client.id,
      lead_id: lead!.id,
      event_type: "setter_off_skip",
      metadata: { locationId, note: "reply skipped - setter off" },
    });
    return NextResponse.json({ ok: true, skipped: "setter_off", client: client.slug });
  }

  // --- Human takeover: if the AI is paused for this lead, keep recording
  //     their messages but do NOT let the AI reply. ---
  if (lead!.ai_paused) {
    console.log("[webhook] AI paused for this lead — message saved, no reply.");
    await logEvent({
      client_id: client.id,
      lead_id: lead!.id,
      event_type: "ai_paused_skip",
      metadata: { locationId },
    });
    return NextResponse.json({ ok: true, skipped: "ai_paused", client: client.slug });
  }

  // --- Tag gate: if the contact has a stop tag (e.g. "ai off"), disengage.
  //     Add one in GHL to silence the AI for that person; remove it to resume. ---
  if (hasStopTag(body.tags)) {
    console.log("[webhook] stop tag present — AI disengaged for this contact.");
    await logEvent({
      client_id: client.id,
      lead_id: lead!.id,
      event_type: "skip_stop_tag",
      metadata: { locationId, tags: body.tags ?? null },
    });
    return NextResponse.json({ ok: true, skipped: "stop_tag", client: client.slug });
  }

  // NOTE: Swedish is NO LONGER a disengage signal. A Swedish-speaking LEAD is
  // engaged in Swedish: the reply pipeline detects the language, asks "snackar
  // du svenska?" once, then locks the whole thread to Swedish and remembers it
  // (see lib/language.ts + generateAndSendReply below). Maher's actual
  // friends/family are kept out by the screener's friend detection and the
  // ban/stop-tag gates — not by language.

  // --- 9. Fire off the screener + AI reply in the background and return 200 ---
  // waitUntil keeps the serverless function alive until this promise settles.
  // Without it, Vercel freezes the instance the moment we return the response,
  // and the background work (which starts with a 5s debounce) never runs.
  waitUntil(
    handleLeadPipeline({ client, lead, inboundMessageId }).catch((err) => {
      console.error("[webhook] background lead pipeline failed:", err);
    })
  );

  return NextResponse.json({ ok: true, client: client.slug });
}

/**
 * Orchestrates the screener (Part A) + reply + ongoing tagging (Part B)
 * AROUND the existing reply pipeline. Runs entirely in the background.
 *
 *  - First contact (leads.screened = false): run the screener FIRST. It tags,
 *    and for non-ICP verdicts it pauses + pings + logs and we do NOT reply.
 *    On an ICP "engage", we continue to the normal reply (feeding any GHL
 *    history in so it continues seamlessly).
 *  - Already screened (and not paused): run ongoing tagging ALONGSIDE the
 *    reply — it must never block or delay the reply.
 */
async function handleLeadPipeline(params: {
  client: Awaited<ReturnType<typeof getClientByGHLLocation>>;
  lead: Awaited<ReturnType<typeof findOrCreateLead>>;
  inboundMessageId?: string;
}) {
  const { client, lead, inboundMessageId } = params;
  if (!client || !lead) return;

  if (!lead.screened) {
    const outcome = await runFirstContactScreener({ client, lead });
    if (!outcome.shouldReply) return; // skip_owner / skip_friend / hold — no reply
    await generateAndSendReply({
      client,
      lead,
      priorHistory: outcome.priorHistory,
      inboundMessageId,
    });
    return;
  }

  // Already screened ICP lead: tag in the background, never blocking the reply.
  void runOngoingTagging({ client, lead }).catch((err) =>
    console.error("[webhook] ongoing tagging failed:", err)
  );
  await generateAndSendReply({ client, lead, inboundMessageId });
}

async function generateAndSendReply(params: {
  client: Awaited<ReturnType<typeof getClientByGHLLocation>>;
  lead: Awaited<ReturnType<typeof findOrCreateLead>>;
  // Prior thread (oldest-first) fetched from GHL by the screener, fed in so a
  // newly-screened conversation continues seamlessly. Usually undefined.
  priorHistory?: Message[];
  // The id of the inbound lead message this invocation is handling. Used to
  // coalesce rapid bursts: if a newer lead message lands during the debounce
  // wait, that later invocation owns the reply and this one bails.
  inboundMessageId?: string;
}) {
  const { client, lead, priorHistory, inboundMessageId } = params;
  if (!client || !lead) return;

  // --- Burst debounce (quiet window): wait, then only proceed if no newer lead
  //     message has arrived. Each inbound DM spawns its own background
  //     invocation; they all wait the same quiet window, so when a lead fires
  //     several messages a few seconds apart, every earlier invocation sees a
  //     newer message and yields, and only the one holding the latest message
  //     proceeds. Net effect: the lead gets ONE reply, ~a quiet window after
  //     their LAST message. A message sent minutes later is past the window and
  //     correctly gets its own reply. ---
  await new Promise((resolve) => setTimeout(resolve, replyDelayMs(client)));

  if (inboundMessageId) {
    try {
      const latest = await getLatestLeadMessage(lead.id);
      if (latest && latest.id !== inboundMessageId) {
        console.log(
          "[webhook] newer lead message arrived during quiet window — yielding to it"
        );
        return;
      }
    } catch (err) {
      // Fail-safe: never DROP a reply because the freshness check failed. The
      // single-flight lock below still prevents a duplicate if we proceed.
      console.error(
        "[webhook] quiet-window freshness check failed — proceeding to reply:",
        err
      );
    }
  }

  // --- Single-flight lock: only ONE invocation may generate + send for this
  //     lead at a time. If another already holds it, this burst is being
  //     handled there, so we bail. Together with the quiet window above this is
  //     the hard guarantee of EXACTLY ONE reply per burst — it closes the race
  //     where a 2nd/3rd fast message's invocation slips past the freshness
  //     check and would otherwise fire its own (often repeated) reply. ---
  const gotLock = await acquireReplyLock(lead.id, REPLY_LOCK_TTL_MS);
  if (!gotLock) {
    console.log("[webhook] a reply is already in flight for this lead — skipping");
    return;
  }

  try {
    await runReplyGeneration({ client, lead, priorHistory });
  } finally {
    // Always free the lock — even if generation/sending threw — so the next
    // inbound for this lead is never blocked by a stuck lock.
    await releaseReplyLock(lead.id);
  }
}

/**
 * Generate the lead's single reply and send it. Runs UNDER the per-lead
 * single-flight lock held by the caller, after the quiet window has already
 * chosen this invocation to answer the burst. Reads the FULL conversation
 * (every message in the burst) so it's all answered at once, and refuses to
 * re-send a near-duplicate of its own previous reply.
 */
async function runReplyGeneration(params: {
  client: Awaited<ReturnType<typeof getClientByGHLLocation>>;
  lead: Awaited<ReturnType<typeof findOrCreateLead>>;
  priorHistory?: Message[];
}) {
  const { client, lead, priorHistory } = params;
  if (!client || !lead) return;

  // Full conversation history (no practical cap): IG-DM threads are small
  // enough that the whole thread fits, and the generator must see everything
  // already covered so it never re-asks answered questions.
  const dbMessages = await getRecentMessages(lead.id, MAX_GENERATION_HISTORY);

  if (dbMessages.length === 0) {
    console.warn("[webhook] no messages found after save");
    return;
  }

  const lastMsg = dbMessages[dbMessages.length - 1];
  if (lastMsg.role !== "lead") {
    console.log("[webhook] skipping: already replied (burst handling)");
    return;
  }

  // --- Outbound circuit breakers (see constants at top). Fail-open when a
  //     count comes back null (transient DB error): a hiccup must not silence
  //     the setter, and the lock/debounce/dedup guards still apply. ---
  const hourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const [leadHourCount, clientHourCount] = await Promise.all([
    countAiMessagesSince(lead.id, hourAgoIso),
    countClientAiMessagesSince(client.id, hourAgoIso),
  ]);
  const leadLimited =
    leadHourCount != null && leadHourCount >= MAX_AI_MSGS_PER_LEAD_PER_HOUR;
  const clientLimited =
    clientHourCount != null && clientHourCount >= MAX_AI_MSGS_PER_CLIENT_PER_HOUR;
  if (leadLimited || clientLimited) {
    const event_type = leadLimited
      ? "rate_limit_lead_hold"
      : "rate_limit_client_hold";
    const alreadyPinged = await recentEventExists({
      client_id: client.id,
      lead_id: leadLimited ? lead.id : undefined,
      event_type,
      since_iso: hourAgoIso,
    });
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type,
      metadata: { lead_hour: leadHourCount, client_hour: clientHourCount },
    });
    if (!alreadyPinged) {
      await sendTelegramPing(
        leadLimited
          ? `🛑 Setter safety brake: this lead already got ${leadHourCount} AI messages in the last hour, so I'm holding further replies to them for now (protects the IG account from spam flags). They'll get a reply on their next message once it cools down.\n${ghlContactLink(client.ghl_location_id ?? "", lead.ghl_contact_id ?? "")}`
          : `🛑 Setter safety brake: ${clientHourCount} AI DMs went out in the last hour across all leads — holding replies until volume drops (protects the IG account from spam flags).`
      );
    }
    console.log("[webhook] rate-limit hold:", event_type, {
      leadHourCount,
      clientHourCount,
    });
    return;
  }

  // The full conversation fed to both the stage manager and the generator.
  const history: Message[] = [
    ...(priorHistory ?? []),
    ...dbMessages.map((m) => ({
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    })),
  ];

  // --- Stage tracking: figure out exactly where in the funnel we are, capture
  //     any new facts, and rail the reply to this one step. No-ops cleanly if
  //     the client has no stages configured (legacy full-script behaviour). ---
  let stageContext: StageContext | undefined;
  // Carried out of the stages block so the post-send GHL pipeline auto-move
  // (below, once the reply is actually delivered) knows where in the funnel we
  // landed. Stays null for legacy clients with no stages → auto-move no-ops.
  let resolvedFunnelStageId: string | null = null;
  // "Dig deeper into pain" overlay: when the tracker flags an emotionally heavy
  // disclosure, this carries the per-reply empathy directive out of the stages
  // block to the generateReply call. Stays undefined unless the client has
  // pain_dig_enabled AND the tracker fired this turn → totally inert when off.
  let painInstruction: string | undefined;
  const stages = parseStages(client.stages);
  if (stages.length > 0) {
    const resolution = await resolveStage({
      stages,
      // The setter's OWN funnel position — NOT lead.stage (the GHL pipeline
      // stage, owned by the Jarvis watcher). Reading lead.stage here is what
      // used to corrupt the funnel ("New Lead" => reset to opener => re-ask).
      currentStageId: lead.funnel_stage ?? null,
      stageData: lead.stage_data ?? {},
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      painEnabled: client.pain_dig_enabled === true,
      painProtocol: client.pain_protocol ?? null,
      whaleEnabled: client.whale_radar_enabled === true,
    });

    // WHALE RADAR: the first time a lead scores as a high-value whale, ping the
    // owner (only him) so he/Ethan can jump in personally. Once per lead, and
    // skipped entirely for any lead he's muted (whale_paused).
    if (client.whale_radar_enabled === true && lead.whale_paused !== true && resolution.whale && resolution.whale.score >= WHALE_THRESHOLD) {
      const alreadyFlagged = await eventExists(lead.id, "whale_flagged");
      if (!alreadyFlagged) {
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "whale_flagged",
          metadata: { score: resolution.whale.score, reason: resolution.whale.reason },
        });
        const nm = lead.full_name || lead.ig_username || "a lead";
        const handle = lead.ig_username ? ` (@${lead.ig_username})` : "";
        const link = client.ghl_location_id && lead.ghl_contact_id
          ? `\nJump in: ${ghlContactLink(client.ghl_location_id, lead.ghl_contact_id)}` : "";
        await sendTelegramPing(`🐳 WHALE in the DMs — ${nm}${handle}\n${resolution.whale.reason} (score ${resolution.whale.score}/100)${link}`);
      }
    }

    // Emotionally heavy moment → pause the funnel and dig with empathy this
    // reply. The stage is already held (resolveStage froze it); here we just
    // build the per-reply directive and note it for the brain. Captured pain
    // facts are persisted with stage_data below, so they're remembered for the
    // rest of the conversation and available at pitch time.
    if (resolution.digPain) {
      painInstruction = painDigInstruction(
        painProtocolFor(client.pain_protocol),
        resolution.stageData
      );
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "pain_dig",
        metadata: { stage: resolution.stage.id, reason: resolution.reason },
      });
    }

    // Persist where we are + what we've learned (sticky across messages).
    await updateLeadStage({
      lead_id: lead.id,
      stage: resolution.stage.id,
      stage_data: resolution.stageData,
    });
    resolvedFunnelStageId = resolution.stage.id;

    if (resolution.advanced) {
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "stage_advanced",
        metadata: { stage: resolution.stage.id, reason: resolution.reason },
      });
    }

    // Sync the captured email onto the GHL contact (once) so when the lead books
    // via the calendar widget, GHL matches them to this SAME contact instead of
    // creating a duplicate. The IG contact otherwise has no email to dedupe on.
    const capturedEmail = resolution.stageData.email;
    if (
      typeof capturedEmail === "string" &&
      capturedEmail.includes("@") &&
      client.ghl_api_key &&
      lead.ghl_contact_id
    ) {
      const alreadySynced = await eventExists(lead.id, "contact_email_synced");
      if (!alreadySynced) {
        const r = await updateContactEmail(
          client.ghl_api_key,
          lead.ghl_contact_id,
          capturedEmail.trim()
        );
        if (r.success) {
          await logEvent({
            client_id: client.id,
            lead_id: lead.id,
            event_type: "contact_email_synced",
            metadata: { email: capturedEmail.trim() },
          });
        }
      }
    }

    // Disqualify branch (e.g. 3rd-world location per the operator's rules):
    // pause the AI (pauseLead pings Maher), and do NOT reply.
    if (resolution.disqualify) {
      await pauseLead({ client, lead, notify: { label: "Disqualified lead (auto-paused)", reason: resolution.reason } });
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "stage_disqualified",
        metadata: { stage: resolution.stage.id, reason: resolution.reason },
      });
      // Move the GHL card to "Disqualified" too (best-effort, forward-guarded —
      // leaves a booked/won card alone). The watcher logs the GHL milestone on
      // its next pass.
      await syncPipelineDisqualified({ client, lead });
      return;
    }

    // On the Book stage, pull Ethan's REAL open slots so the setter offers
    // actual availability instead of inventing times. We fetch them IN THE
    // LEAD'S timezone (derived from the country we captured), so GHL returns the
    // slots already in their local time and we never have to convert by hand.
    // Best-effort: any failure leaves availableSlots undefined and the Book
    // stage falls back to a concrete range (the prompt handles that branch).
    let availableSlots: string[] | undefined;
    const leadTimezone =
      countryToTimezone(
        typeof resolution.stageData.location === "string"
          ? resolution.stageData.location
          : null
      ) || client.timezone;
    if (
      resolution.stage.id === "book" &&
      client.ghl_calendar_id &&
      client.ghl_api_key
    ) {
      try {
        const free = await getFreeSlots(client.ghl_api_key, client.ghl_calendar_id, {
          timezone: leadTimezone,
        });
        availableSlots = free.slots;
      } catch (err) {
        console.error("[webhook] getFreeSlots failed:", err);
      }
    }

    stageContext = {
      name: resolution.stage.name,
      goal: resolution.stage.goal,
      playbook: resolution.stage.playbook,
      knownFacts: resolution.stageData,
      objection: resolution.objection,
      funnelMap: stages.map((s) => s.name),
      availableSlots,
      slotsTimezone: leadTimezone,
    };
  }

  // --- Conversation language: detect Swedish, ask "snackar du svenska?" once,
  //     then LOCK the thread to Swedish and remember it. Runs only when there's
  //     a Swedish hint (or we're awaiting an answer), so plain English threads
  //     pay nothing extra. Best-effort: on any error it leaves language as-is. ---
  const knownLocation =
    lead.stage_data?.location ?? stageContext?.knownFacts?.location;
  const lang = await resolveConversationLanguage({
    current: lead.conversation_language,
    history,
    knownLocation,
  });
  if (lang.state !== (lead.conversation_language ?? "en")) {
    await updateLeadLanguage(lead.id, lang.state);
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type:
        lang.state === "sv"
          ? "language_locked_sv"
          : lang.state === "sv_pending"
          ? "language_ask_swedish"
          : lang.state === "en_declined"
          ? "language_declined"
          : "language_changed",
      metadata: { from: lead.conversation_language ?? "en", to: lang.state },
    });
  }

  const genClient = {
    name: client.name,
    slug: client.slug,
    system_prompt: client.system_prompt,
    voice_samples: client.voice_samples,
    active_rules: client.active_rules,
    business_context: client.business_context,
    timezone: client.timezone,
  };

  // --- Late-straggler detection: did the lead's newest message land shortly
  //     after our last reply went out? If so, give the model the option to
  //     judge it already-answered and stay silent (see constants at top). ---
  const lastAiMsg = [...dbMessages].reverse().find((m) => m.role === "ai");
  let lateFollowOn = false;
  if (lastAiMsg) {
    const gapMs =
      new Date(lastMsg.created_at).getTime() -
      new Date(lastAiMsg.created_at).getTime();
    lateFollowOn = gapMs >= 0 && gapMs <= LATE_FOLLOW_ON_WINDOW_MS;
  }
  const lateInstruction = lateFollowOn ? LATE_FOLLOW_ON_INSTRUCTION : undefined;
  // Voice notes: tell the brain it can speak a message (in the operator's voice)
  // only when the overlay is live for this thread (enabled + clone id + English).
  const voiceOn = lead.voice_paused !== true && voiceActive({
    enabled: client.voice_enabled,
    voiceId: client.setter_voice_id,
    voiceIdSv: client.setter_voice_id_sv,
    langState: lang.state,
  });
  const voiceId = voiceIdForLang({
    voiceId: client.setter_voice_id,
    voiceIdSv: client.setter_voice_id_sv,
    langState: lang.state,
  });
  const voiceInstruction = voiceOn ? VOICE_INSTRUCTION : undefined;
  // The per-reply directive(s) folded into THIS reply: voice capability, the
  // pain-dig empathy overlay (when it fired) and/or the late-straggler note.
  const baseInstruction =
    [voiceInstruction, painInstruction, lateInstruction].filter(Boolean).join("\n\n") || undefined;

  let aiResult;
  try {
    aiResult = await generateReply({
      client: genClient,
      history,
      stage: stageContext,
      language: lang.directive ?? undefined,
      extraInstruction: baseInstruction,
    });
  } catch (err) {
    console.error("[webhook] generateReply failed:", err);
    await logAIDecision({
      lead_id: lead.id,
      client_id: client.id,
      system_prompt_used: "(failed before send)",
      conversation_context: { messages: dbMessages.length },
      raw_response: "",
      error: err instanceof Error ? err.message : "Unknown error",
    });
    return;
  }

  // --- Anti-repeat guard: never re-send a near-copy of something we already
  //     said. If the fresh reply repeats a recent AI bubble, regenerate ONCE
  //     telling the model not to repeat. CRITICAL: only ever go SILENT on a
  //     late-straggler (a quick follow-on we may have already answered) — on a
  //     real lead turn we must NEVER ghost them, so if it's still similar we
  //     send the regenerated reply anyway. The [[VOICE]] marker is stripped
  //     before comparing so a spoken line isn't mis-flagged. ---
  const stripMark = (segs: string[]) => segs.map((s) => s.replace(VOICE_MARKER_RE, "").trim());
  const priorAiBubbles = dbMessages
    .filter((m) => m.role === "ai")
    .slice(-6)
    .map((m) => m.content);
  if (isRepeatReply(stripMark(aiResult.segments), priorAiBubbles)) {
    console.log("[webhook] generated reply repeats a recent message — regenerating once");
    try {
      const antiRepeatInstruction =
        "You have ALREADY sent your most recent 'assistant' messages above. Do NOT repeat them, reword them, or re-ask a question you have already asked. The lead has seen them. Move the conversation FORWARD to the next step of the process instead.";
      const retry = await generateReply({
        client: genClient,
        history,
        stage: stageContext,
        language: lang.directive ?? undefined,
        extraInstruction: baseInstruction
          ? `${baseInstruction}\n\n${antiRepeatInstruction}`
          : antiRepeatInstruction,
      });
      if (isRepeatReply(stripMark(retry.segments), priorAiBubbles) && lateFollowOn) {
        // ONLY stay silent for a straggler we likely already answered — never
        // for a real lead turn (that's the ghosting bug).
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "ai_reply_suppressed_duplicate",
          metadata: { sample: (aiResult.segments[0] ?? "").slice(0, 140) },
        });
        console.log("[webhook] late straggler still duplicate after retry — suppressing");
        return;
      }
      // Real lead turn: send the regenerated reply even if it still resembles a
      // prior line. Better a slightly-similar message than ghosting the lead.
      aiResult = retry;
    } catch (err) {
      // A failed regeneration must not drop the reply — fall through and send
      // the original rather than leave the lead hanging.
      console.error("[webhook] anti-repeat regeneration failed:", err);
    }
  }

  // --- Human "leave it on read": the model judged the lead's late follow-on
  //     as already covered by the reply that just went out (or as a bare
  //     acknowledgment needing nothing). Send NOTHING. The message stays in
  //     history, so the next real inbound is answered with full context. ---
  if (
    aiResult.reply.includes(NO_REPLY_TOKEN) ||
    aiResult.raw_response.includes(NO_REPLY_TOKEN)
  ) {
    await logAIDecision({
      lead_id: lead.id,
      client_id: client.id,
      system_prompt_used: aiResult.system_prompt_used,
      conversation_context: { messages: dbMessages.length },
      raw_response: aiResult.raw_response,
      final_reply: NO_REPLY_TOKEN,
      duration_ms: aiResult.duration_ms,
    });
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "ai_no_reply_choice",
      metadata: { lead_message: lastMsg.content.slice(0, 140) },
    });
    console.log("[webhook] model chose NO_REPLY for late follow-on — staying silent");
    return;
  }

  // --- Cap the volley: past MAX_BUBBLES_PER_REPLY, merge the overflow into
  //     the last bubble instead of dropping it (a booking link in bubble 6
  //     must still reach the lead — just inside bubble 4). ---
  const cappedSegments =
    aiResult.segments.length <= MAX_BUBBLES_PER_REPLY
      ? aiResult.segments
      : [
          ...aiResult.segments.slice(0, MAX_BUBBLES_PER_REPLY - 1),
          aiResult.segments.slice(MAX_BUBBLES_PER_REPLY - 1).join("\n"),
        ];

  // --- Phase 2: tag any booking/calendar link the AI is about to send with
  //     utm_medium=ai_dm. We save + send the SAME tagged text so the DB record
  //     and the lead's DM match. ---
  // --- Build the outbound plan. Each capped segment goes out as TEXT, or — when
  //     the brain marked it [[VOICE]] AND voice is live + the line is eligible
  //     (no links/times, right length) — as a VOICE NOTE (audio only) in the
  //     operator's cloned voice. We always SAVE the words (so memory + anti-
  //     repeat work on text); a voice message is just DELIVERED as an mp3. Any
  //     clip failure falls back to sending that message as text — never dropped.
  //     When voice is off this loop is equivalent to the old tag+send path. ---
  type Outbound = { saveText: string; message: string; attachments?: string[]; fallbackText?: string; hadBookingLink: boolean; voice: boolean };
  const plan: Outbound[] = [];
  for (const seg of cappedSegments) {
    const marked = VOICE_MARKER_RE.test(seg);
    const body = seg.replace(VOICE_MARKER_RE, "").trim();
    if (voiceOn && marked && voiceEligible(body) && voiceId) {
      const url = await makeVoiceClip(body, voiceId);
      if (url) {
        // fallbackText: if GHL rejects the audio, the words still go as text.
        plan.push({ saveText: body, message: "", attachments: [url], fallbackText: body, hadBookingLink: false, voice: true });
        continue;
      }
      console.error("[webhook] voice clip failed — falling back to text");
    }
    const t = tagBookingLinks(body);
    plan.push({ saveText: t.text, message: t.text, hadBookingLink: t.hadBookingLink, voice: false });
  }

  const segmentsToSend = plan.map((p) => p.saveText);
  const hadBookingLink = plan.some((p) => p.hadBookingLink);
  const voiceCount = plan.filter((p) => p.voice).length;

  // Save AI messages (content = the words said/typed), keeping the rows so we can
  // stamp each with its GHL id (lets the outbound webhook tell the AI's own echo
  // from a human send).
  const savedAiRows: (DbMessage | null)[] = [];
  for (let i = 0; i < plan.length; i++) {
    const row = await saveMessage({
      lead_id: lead.id,
      client_id: client.id,
      role: "ai",
      content: plan[i].saveText,
      model_used: PRODUCTION_MODEL,
      input_tokens: i === 0 ? aiResult.input_tokens : undefined,
      output_tokens: i === 0 ? aiResult.output_tokens : undefined,
    });
    savedAiRows.push(row);
  }

  await logAIDecision({
    lead_id: lead.id,
    client_id: client.id,
    system_prompt_used: aiResult.system_prompt_used,
    conversation_context: { messages: dbMessages.length },
    raw_response: aiResult.raw_response,
    final_reply: aiResult.reply,
    duration_ms: aiResult.duration_ms,
  });

  const sendResults = await sendGHLMixedSequence({
    ghl_api_key: client.ghl_api_key!,
    ghl_location_id: client.ghl_location_id!,
    ghl_contact_id: lead.ghl_contact_id!,
    type: "IG",
    items: plan.map((p) => ({ message: p.message, attachments: p.attachments, fallbackText: p.fallbackText })),
  });

  // Stamp the GHL message id onto each AI row for outbound-echo dedupe.
  for (let i = 0; i < sendResults.length; i++) {
    const r = sendResults[i];
    const row = savedAiRows[i];
    if (r?.success && r.ghl_message_id && row) {
      await setMessageGhlId(row.id, r.ghl_message_id);
    }
  }

  const allSent = sendResults.every((r) => r.success);
  const anySent = sendResults.some((r) => r.success);

  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: allSent ? "ai_replied" : "ai_reply_failed",
    metadata: {
      segments: segmentsToSend.length,
      voice_notes: voiceCount,
      duration_ms: aiResult.duration_ms,
      send_errors: sendResults.filter((r) => !r.success).map((r) => r.error),
    },
  });

  // Phase 2: the AI just sent a booking/calendar link.
  if (hadBookingLink && anySent) {
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "ai_sent_booking_link",
      metadata: { at: new Date().toISOString() },
    });
  }

  // Nurture anchor: the AI just sent the pre-call training video → schedule the
  // +30min "what was your takeaway?" touch (no-op if nurture is disabled).
  if (anySent && segmentsToSend.some((s) => s.includes(VIDEO_LINK))) {
    await recordVideoLinkSent(client.id, lead);
  }

  if (allSent) {
    await supabase
      .from("leads")
      .update({ status: "engaged" })
      .eq("id", lead.id)
      .eq("status", "new");
  }

  // --- GHL pipeline auto-move: now that a reply actually went out, nudge the
  //     lead's CARD forward to match where the setter's funnel landed (active
  //     conversation → "Waiting For Reply", pitch reached → "Call Pitched").
  //     Forward-only + move-only-never-create + booked/closed cards untouched.
  //     The Jarvis watcher logs the milestone event on its next pass, so the
  //     dashboard/HQ need no changes. Best-effort: never blocks anything. ---
  if (anySent) {
    await syncPipelineFunnel({ client, lead, funnelStageId: resolvedFunnelStageId });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "ai-setter-webhook",
    routing: "by_ghl_location_id",
    timestamp: new Date().toISOString(),
  });
}
