/**
 * GoHighLevel API client.
 *
 * Used for OUTBOUND only — sending replies back to leads via GHL,
 * which forwards them to Instagram DMs.
 *
 * INBOUND messages come in via webhooks (see /app/api/webhook/ghl/route.ts).
 *
 * Auth: Uses a Private Integration Token (PIT) per location. Stored in
 * the clients.ghl_api_key column in Supabase, encrypted in production.
 *
 * For V1, we keep it unencrypted since there's only one client (you).
 * When we onboard real clients we'll add proper encryption with libsodium.
 */

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-04-15"; // Required header version (messaging + conversations)
// Tag add/remove endpoints expect the contacts API version.
const GHL_TAGS_API_VERSION = "2021-07-28";

import { supabase } from "./supabase";

/**
 * Fire-and-forget diagnostic write to a table we can read back from Supabase.
 * Vercel's runtime log tooling doesn't surface our console output, so for hard
 * cases (e.g. why an IG voice note's attachment can't be found) we record the
 * raw API shape here and inspect it directly. Never throws.
 */
function writeDiag(kind: string, data: unknown): void {
  supabase
    .from("webhook_debug_logs")
    .insert({ parse_result: kind, extracted_data: data as never })
    .then(undefined, () => {});
}

export interface SendMessageParams {
  ghl_api_key: string;        // Per-location PIT
  ghl_location_id: string;    // The GHL sub-account ID
  ghl_contact_id: string;     // Who to send to
  message: string;            // The text to send (may be "" when sending audio only)
  type?: "IG" | "SMS" | "Email" | "WhatsApp" | "FB";  // Channel
  attachments?: string[];     // Public file URLs (e.g. an mp3 voice note). Optional.
}

export interface SendMessageResult {
  success: boolean;
  ghl_message_id?: string;
  error?: string;
}

/**
 * Send a single message via GHL → Instagram DM.
 */
export async function sendGHLMessage(
  params: SendMessageParams
): Promise<SendMessageResult> {
  const url = `${GHL_API_BASE}/conversations/messages`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${params.ghl_api_key}`,
        "Content-Type": "application/json",
        "Version": GHL_API_VERSION,
      },
      body: JSON.stringify({
        type: params.type ?? "IG",
        contactId: params.ghl_contact_id,
        message: params.message,
        ...(params.attachments && params.attachments.length
          ? { attachments: params.attachments }
          : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] sendMessage failed:", response.status, errorText);
      return { success: false, error: `${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return {
      success: true,
      ghl_message_id: data.messageId || data.id,
    };
  } catch (err) {
    console.error("[ghl] sendMessage threw:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// Human-like cadence: think -> write -> send, then the next one. Each bubble
// waits a pause proportional to ITS OWN length BEFORE it's sent (so a short
// "ok bro" fires fast and a longer line takes a beat to "type"), instead of a
// flat gap that makes a volley feel scripted or land in a burst. ~3 chars/sec
// (≈40 wpm) + a short "thinking" base + jitter so the rhythm never repeats.
// Per-bubble and total caps keep the whole volley inside the Vercel window.
const TYPE_BASE_MS = 900; // brief "thinking/reading" before a bubble
const TYPE_CHARS_PER_SEC = 3; // ~40 wpm typing feel
const MIN_BUBBLE_PAUSE_MS = 700;
const MAX_BUBBLE_PAUSE_MS = 8_000; // no single "typing" gap longer than this
const PAUSE_JITTER_MS = 600;
const MAX_TOTAL_PACING_MS = 32_000; // fits the 60s function budget (6s window + gen + sends)

/** Length-proportional "typing" pause for a single bubble. */
function typingPauseFor(text: string): number {
  const chars = (text || "").length;
  const want = TYPE_BASE_MS + (chars / TYPE_CHARS_PER_SEC) * 1000;
  const jitter = (Math.random() - 0.5) * PAUSE_JITTER_MS;
  return Math.min(Math.max(MIN_BUBBLE_PAUSE_MS, Math.round(want + jitter)), MAX_BUBBLE_PAUSE_MS);
}

/**
 * Send multiple messages as one paced sequence.
 * Used when the AI returns a reply with [[SPLIT]] tokens.
 *
 * Every bubble after the first waits a typing-speed pause before it is sent
 * (capped by a total budget), so a volley reads like a person typing, not a
 * script. Runs in the background (the webhook returns 200 first).
 */
export async function sendGHLMessageSequence(
  params: Omit<SendMessageParams, "message"> & { messages: string[] }
): Promise<SendMessageResult[]> {
  const results: SendMessageResult[] = [];
  let pacingSpent = 0;

  for (let i = 0; i < params.messages.length; i++) {
    const msg = params.messages[i];

    if (i > 0 && pacingSpent < MAX_TOTAL_PACING_MS) {
      const pause = Math.min(typingPauseFor(msg), MAX_TOTAL_PACING_MS - pacingSpent);
      pacingSpent += pause;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }

    const result = await sendGHLMessage({
      ghl_api_key: params.ghl_api_key,
      ghl_location_id: params.ghl_location_id,
      ghl_contact_id: params.ghl_contact_id,
      message: msg,
      type: params.type,
    });

    results.push(result);

    // If one fails, stop sending the rest
    if (!result.success) break;
  }

  return results;
}

/**
 * Send a paced sequence where each item is EITHER a text bubble or a voice clip
 * (an audio attachment). Same human pacing as sendGHLMessageSequence — used when
 * a reply mixes text and voice notes. Stops on the first failure.
 */
export interface OutboundItem {
  message: string;          // text body ("" when sending audio only)
  attachments?: string[];   // public mp3 URL(s) for a voice note
  fallbackText?: string;    // if an audio send fails, send THIS as text instead
}
export async function sendGHLMixedSequence(
  params: Omit<SendMessageParams, "message" | "attachments"> & { items: OutboundItem[] }
): Promise<SendMessageResult[]> {
  const results: SendMessageResult[] = [];
  let pacingSpent = 0;

  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i];
    if (i > 0 && pacingSpent < MAX_TOTAL_PACING_MS) {
      // think -> type THIS bubble -> send it
      const want = typingPauseFor(item.message || item.fallbackText || "");
      const pause = Math.min(want, MAX_TOTAL_PACING_MS - pacingSpent);
      pacingSpent += pause;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
    let result = await sendGHLMessage({
      ghl_api_key: params.ghl_api_key,
      ghl_location_id: params.ghl_location_id,
      ghl_contact_id: params.ghl_contact_id,
      message: item.message,
      attachments: item.attachments,
      type: params.type,
    });

    // If a VOICE note (attachment) fails to send, never drop it — fall back to
    // sending the spoken words as plain text so the reply still lands.
    if (!result.success && item.attachments?.length && item.fallbackText?.trim()) {
      console.error("[ghl] audio attachment send failed — retrying as text");
      result = await sendGHLMessage({
        ghl_api_key: params.ghl_api_key,
        ghl_location_id: params.ghl_location_id,
        ghl_contact_id: params.ghl_contact_id,
        message: item.fallbackText,
        type: params.type,
      });
    }

    results.push(result);
    if (!result.success) break;
  }

  return results;
}

/** Standard auth headers for GHL v2 API calls. */
function ghlHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_API_VERSION,
    Accept: "application/json",
  };
}

// ===========================================================================
// CONTACT TAGS (used by the ICP screener + ongoing tagging)
// ---------------------------------------------------------------------------
// GHL lowercases all tags. Tags we use: icp, qualified, biz owner, friend,
// needs review (plus the pause tag "ai off").
//   Add:    POST   /contacts/{id}/tags  body {"tags":[...]}
//   Remove: DELETE /contacts/{id}/tags  body {"tags":[...]}
// Headers: Authorization: Bearer {key}, Version: 2021-07-28, Content-Type: json
// ===========================================================================

export interface TagResult {
  success: boolean;
  status?: number;
  error?: string;
}

/** Headers for the contacts/tags endpoints. */
function ghlTagHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_TAGS_API_VERSION,
    "Content-Type": "application/json",
  };
}

/** Add one or more tags to a GHL contact. Tags are lowercased by GHL. */
export async function addContactTags(
  apiKey: string,
  contactId: string,
  tags: string[]
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/contacts/${contactId}/tags`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({ tags }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] addContactTags failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[ghl] addContactTags threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Remove one or more tags from a GHL contact.
 * DELETE with a JSON body — fetch() supports a body on DELETE.
 */
export async function removeContactTags(
  apiKey: string,
  contactId: string,
  tags: string[]
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/contacts/${contactId}/tags`;
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({ tags }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] removeContactTags failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[ghl] removeContactTags threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Set the email on a GHL contact. GHL dedupes contacts by email/phone, so
 * writing the lead's email onto the existing Instagram contact BEFORE they book
 * makes the calendar booking attach to that SAME contact instead of spawning a
 * duplicate (the IG contact otherwise has no email to match on). Best-effort.
 */
export async function updateContactEmail(
  apiKey: string,
  contactId: string,
  email: string
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/contacts/${contactId}`;
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({ email }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] updateContactEmail failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[ghl] updateContactEmail threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Permanently DELETE a contact from GHL.
 *
 * Used by the first-contact screener to erase unsolicited service-pitch
 * spammers (people who DM us cold trying to sell us services) so they vanish
 * from the CRM entirely — no contact, no conversation, no trace. This is
 * irreversible in GHL, so the screener only calls it on a CLEAR pitch with
 * zero prior history. Best-effort: returns success:false on failure (the
 * caller logs it) rather than throwing into the webhook background task.
 *
 *   DELETE /contacts/{id}   Headers: Authorization, Version 2021-07-28
 */
export async function deleteContact(
  apiKey: string,
  contactId: string
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/contacts/${contactId}`;
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: ghlTagHeaders(apiKey),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ghl] deleteContact failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[ghl] deleteContact threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ===========================================================================
// CONVERSATION HISTORY (used by the first-contact screener)
// ---------------------------------------------------------------------------
//   GET /conversations/search?locationId={loc}&contactId={id} -> conversationId
//   GET /conversations/{conversationId}/messages              -> messages
// ===========================================================================

export interface ThreadMessage {
  role: "lead" | "ai";
  content: string;
  created_at: string;
}

/**
 * Fetch the full DM thread for a contact from GHL, oldest message first.
 *
 * Inbound messages map to role "lead"; outbound to role "ai" (so the thread
 * can be fed straight into the reply generator). THROWS on a hard API failure
 * so the screener can fail-closed (treat a lead with history as "hold" rather
 * than risk engaging on an error). Returns [] when the contact genuinely has
 * no conversation yet.
 */
export async function fetchContactThread(
  apiKey: string,
  locationId: string,
  contactId: string
): Promise<ThreadMessage[]> {
  // 1. Find the conversation for this contact.
  const searchUrl =
    `${GHL_API_BASE}/conversations/search` +
    `?locationId=${encodeURIComponent(locationId)}` +
    `&contactId=${encodeURIComponent(contactId)}`;
  const sres = await fetch(searchUrl, { headers: ghlHeaders(apiKey) });
  if (!sres.ok) {
    const t = await sres.text();
    throw new Error(`conversation search failed: ${sres.status} ${t}`);
  }
  const sdata = await sres.json();
  const convId = sdata?.conversations?.[0]?.id;
  if (!convId) {
    // No conversation on record => no prior history.
    return [];
  }

  // 2. Pull the messages for that conversation.
  const mUrl = `${GHL_API_BASE}/conversations/${convId}/messages?limit=100`;
  const mres = await fetch(mUrl, { headers: ghlHeaders(apiKey) });
  if (!mres.ok) {
    const t = await mres.text();
    throw new Error(`get messages failed: ${mres.status} ${t}`);
  }
  const mdata = await mres.json();
  const list: Array<Record<string, unknown>> =
    mdata?.messages?.messages ?? mdata?.messages ?? [];

  // Oldest first (GHL returns newest first).
  list.sort((a, b) => {
    const da = new Date((a.dateAdded as string) || 0).getTime();
    const db = new Date((b.dateAdded as string) || 0).getTime();
    return da - db;
  });

  const thread: ThreadMessage[] = [];
  for (const msg of list) {
    const dir = String(msg.direction || "").toLowerCase();
    const body = (msg.body as string) || (msg.message as string) || "";
    if (!body.trim()) continue; // skip non-text events (images, reactions)
    thread.push({
      role: dir === "inbound" ? "lead" : "ai",
      content: body,
      created_at: (msg.dateAdded as string) || new Date().toISOString(),
    });
  }
  return thread;
}

export interface InboundMedia {
  url: string;
  messageId?: string;
}

/**
 * Pull an attachment URL out of a GHL message object, tolerating the shapes IG
 * media comes back in: `attachments` as an array of URL strings OR of objects
 * ({ url }), and the occasional `meta.attachments`.
 */
function extractAttachmentUrl(msg: Record<string, unknown> | null | undefined): string | null {
  if (!msg) return null;
  const buckets: unknown[] = [
    msg.attachments,
    (msg.meta as Record<string, unknown> | undefined)?.attachments,
  ];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      if (typeof item === "string" && item.trim()) return item;
      if (item && typeof item === "object") {
        const url = (item as { url?: unknown }).url;
        if (typeof url === "string" && url.trim()) return url;
      }
    }
  }
  return null;
}

/** Fetch a single message by id (its attachments are sometimes only here). */
async function fetchMessageById(
  apiKey: string,
  messageId: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${GHL_API_BASE}/conversations/messages/${messageId}`, {
      headers: ghlHeaders(apiKey),
    });
    if (!res.ok) {
      console.error("[ghl] fetchMessageById failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return (data?.message as Record<string, unknown>) ?? (data as Record<string, unknown>);
  } catch (err) {
    console.error("[ghl] fetchMessageById threw:", err);
    return null;
  }
}

/**
 * Fetch the URL of the most recent INBOUND message attachment for a contact.
 *
 * IG voice notes and images arrive in the webhook as "type 18" events with an
 * empty body and NO media URL, so the only way to get the actual file is to ask
 * the GHL conversations API for it after the fact. The attachment URL is
 * sometimes absent from the messages LIST response and only present on the
 * single-message detail, so we fall back to fetching that. Returns null if the
 * latest inbound message genuinely has no attachment (e.g. a reaction, story
 * reply, or plain text), or if the API call fails.
 */
export async function getLatestInboundAttachment(
  apiKey: string,
  locationId: string,
  contactId: string
): Promise<InboundMedia | null> {
  try {
    // 1. Find the conversation for this contact.
    const searchUrl =
      `${GHL_API_BASE}/conversations/search` +
      `?locationId=${encodeURIComponent(locationId)}` +
      `&contactId=${encodeURIComponent(contactId)}`;
    const sres = await fetch(searchUrl, { headers: ghlHeaders(apiKey) });
    if (!sres.ok) {
      console.error("[ghl] conversation search failed:", sres.status, await sres.text());
      return null;
    }
    const sdata = await sres.json();
    const convId = sdata?.conversations?.[0]?.id;
    if (!convId) {
      console.log("[ghl] no conversation found for contact");
      return null;
    }

    // 2. Pull recent messages, newest first.
    const mUrl = `${GHL_API_BASE}/conversations/${convId}/messages?limit=20`;
    const mres = await fetch(mUrl, { headers: ghlHeaders(apiKey) });
    if (!mres.ok) {
      console.error("[ghl] get messages failed:", mres.status, await mres.text());
      return null;
    }
    const mdata = await mres.json();
    const list: Array<Record<string, unknown>> =
      mdata?.messages?.messages ?? mdata?.messages ?? [];

    list.sort((a, b) => {
      const da = new Date((a.dateAdded as string) || 0).getTime();
      const db = new Date((b.dateAdded as string) || 0).getTime();
      return db - da;
    });

    // DIAGNOSTIC: record what GHL returned so we can see the real attachment
    // shape for IG voice notes (Vercel logs don't surface our console output).
    writeDiag("media_diag", {
      convId,
      count: list.length,
      latestTwoInbound: list
        .filter((m) => String(m.direction || "").toLowerCase() === "inbound")
        .slice(0, 2),
    });

    // 3. Find the latest inbound message and resolve its attachment, falling
    //    back to the single-message detail when the list omits the URL.
    for (const msg of list) {
      const dir = String(msg.direction || "").toLowerCase();
      if (dir !== "inbound") continue;

      let url = extractAttachmentUrl(msg);
      if (!url && msg.id) {
        const detail = await fetchMessageById(apiKey, msg.id as string);
        url = extractAttachmentUrl(detail);
      }
      if (url) return { url, messageId: msg.id as string | undefined };

      // Latest inbound has no attachment at all — log its shape (once) so we can
      // see exactly what GHL sent, then stop (older messages aren't this event).
      console.log(
        "[ghl] latest inbound has no attachment; keys:",
        Object.keys(msg).join(","),
        "| messageType:",
        msg.messageType ?? msg.type ?? "?"
      );
      break;
    }

    return null;
  } catch (err) {
    console.error("[ghl] getLatestInboundAttachment threw:", err);
    return null;
  }
}

// ===========================================================================
// OPPORTUNITIES (used by Jarvis HQ voice actions — "move him in the pipeline")
// ---------------------------------------------------------------------------
//   GET /opportunities/search?location_id={loc}&contact_id={id}
//   GET /opportunities/pipelines?locationId={loc}
//   PUT /opportunities/{id}  body { pipelineId, pipelineStageId }
// All use the contacts API version (2021-07-28). Best-effort: errors are
// returned, never thrown.
// ===========================================================================

export interface GhlOpportunity {
  id: string;
  name?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  status?: string;
}

export interface GhlPipeline {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string }>;
}

/** Find the (first) opportunity attached to a contact, if any. */
export async function findContactOpportunity(
  apiKey: string,
  locationId: string,
  contactId: string
): Promise<GhlOpportunity | null> {
  const url =
    `${GHL_API_BASE}/opportunities/search` +
    `?location_id=${encodeURIComponent(locationId)}` +
    `&contact_id=${encodeURIComponent(contactId)}`;
  try {
    const res = await fetch(url, { headers: ghlTagHeaders(apiKey) });
    if (!res.ok) {
      console.error("[ghl] opportunity search failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const opp = data?.opportunities?.[0];
    if (!opp?.id) return null;
    return {
      id: opp.id,
      name: opp.name,
      pipelineId: opp.pipelineId,
      pipelineStageId: opp.pipelineStageId,
      status: opp.status,
    };
  } catch (err) {
    console.error("[ghl] opportunity search threw:", err);
    return null;
  }
}

/** List the location's pipelines with their stages (for name → id matching). */
export async function listPipelines(
  apiKey: string,
  locationId: string
): Promise<GhlPipeline[]> {
  const url = `${GHL_API_BASE}/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`;
  try {
    const res = await fetch(url, { headers: ghlTagHeaders(apiKey) });
    if (!res.ok) {
      console.error("[ghl] listPipelines failed:", res.status, await res.text());
      return [];
    }
    const data = await res.json();
    const pipelines = Array.isArray(data?.pipelines) ? data.pipelines : [];
    return pipelines.map((p: Record<string, unknown>) => ({
      id: String(p.id ?? ""),
      name: String(p.name ?? ""),
      stages: Array.isArray(p.stages)
        ? (p.stages as Array<Record<string, unknown>>).map((s) => ({
            id: String(s.id ?? ""),
            name: String(s.name ?? ""),
          }))
        : [],
    }));
  } catch (err) {
    console.error("[ghl] listPipelines threw:", err);
    return [];
  }
}

/** Move an opportunity to a different pipeline stage. */
export async function moveOpportunityStage(
  apiKey: string,
  opportunityId: string,
  pipelineId: string,
  pipelineStageId: string
): Promise<TagResult> {
  const url = `${GHL_API_BASE}/opportunities/${encodeURIComponent(opportunityId)}`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: ghlTagHeaders(apiKey),
      body: JSON.stringify({ pipelineId, pipelineStageId }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error("[ghl] moveOpportunityStage failed:", res.status, errorText);
      return { success: false, status: res.status, error: errorText };
    }
    return { success: true, status: res.status };
  } catch (err) {
    console.error("[ghl] moveOpportunityStage threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ===========================================================================
// CALENDAR AVAILABILITY (used by the Book stage to offer REAL open slots)
// ---------------------------------------------------------------------------
//   GET /calendars/{calendarId}/free-slots?startDate={ms}&endDate={ms}&timezone={tz}
//   Headers: Authorization: Bearer {key}, Version: 2021-04-15
// GHL returns an object keyed by date (YYYY-MM-DD), each with a `slots` array of
// ISO timestamps already expressed in the requested timezone, e.g.:
//   { "2026-06-09": { "slots": ["2026-06-09T09:00:00+02:00", ...] }, "traceId": "..." }
// We flatten, sort, and return the next N. Best-effort: on ANY failure (bad
// scope, network, unexpected shape) we return [] so the Book stage falls back
// to loose times instead of inventing — never throws into the reply path.
// ===========================================================================

export interface FreeSlots {
  /** ISO timestamps (with timezone offset) of upcoming open slots, soonest first. */
  slots: string[];
  /** The timezone the slots are expressed in. */
  timezone: string;
}

export async function getFreeSlots(
  apiKey: string,
  calendarId: string,
  opts: { timezone: string; days?: number; limit?: number }
): Promise<FreeSlots> {
  const { timezone, days = 7, limit = 8 } = opts;
  const empty: FreeSlots = { slots: [], timezone };
  if (!apiKey || !calendarId) return empty;

  const start = Date.now();
  const end = start + days * 24 * 60 * 60 * 1000;
  const url =
    `${GHL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/free-slots` +
    `?startDate=${start}&endDate=${end}&timezone=${encodeURIComponent(timezone)}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: GHL_API_VERSION,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("[ghl] getFreeSlots failed:", res.status, errText);
      writeDiag("freeslots_diag", { calendarId, status: res.status, error: errText.slice(0, 300) });
      return empty;
    }
    const data = (await res.json()) as Record<string, unknown>;

    // Collect every `slots` array found under date keys (ignore traceId etc).
    const collected: string[] = [];
    for (const value of Object.values(data)) {
      if (value && typeof value === "object" && Array.isArray((value as { slots?: unknown }).slots)) {
        for (const s of (value as { slots: unknown[] }).slots) {
          if (typeof s === "string") collected.push(s);
        }
      }
    }

    // Sort chronologically and keep only future slots, capped at `limit`.
    const now = Date.now();
    const slots = collected
      .filter((s) => {
        const t = new Date(s).getTime();
        return !Number.isNaN(t) && t > now;
      })
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
      .slice(0, limit);

    writeDiag("freeslots_diag", {
      calendarId,
      status: res.status,
      rawKeys: Object.keys(data).slice(0, 12),
      collected: collected.length,
      returned: slots.length,
      sample: slots.slice(0, 3),
    });

    return { slots, timezone };
  } catch (err) {
    console.error("[ghl] getFreeSlots threw:", err);
    return empty;
  }
}

// ===========================================================================
// UPCOMING APPOINTMENT (used by the nurture engine to time the pre-call check)
//   GET /contacts/{contactId}/appointments  (LeadConnector contacts API)
// Returns { events: [{ startTime, status, ... }] }. We pick the soonest FUTURE,
// non-cancelled event's startTime. Best-effort: ANY failure → null (the
// pre-call reminder is simply skipped, never throws into a caller).
// ===========================================================================
export async function getContactUpcomingAppointment(
  apiKey: string,
  contactId: string
): Promise<string | null> {
  if (!apiKey || !contactId) return null;
  try {
    const res = await fetch(
      `${GHL_API_BASE}/contacts/${encodeURIComponent(contactId)}/appointments`,
      { headers: { Authorization: `Bearer ${apiKey}`, Version: GHL_TAGS_API_VERSION, Accept: "application/json" } }
    );
    if (!res.ok) {
      writeDiag("appt_diag", { contactId, status: res.status, error: (await res.text()).slice(0, 300) });
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    // Shape tolerance: events | appointments | a bare array.
    const list = (Array.isArray(data) ? data
      : (data.events as unknown[]) || (data.appointments as unknown[]) || []) as Record<string, unknown>[];
    const now = Date.now();
    const future = list
      .map((e) => {
        const start = (e.startTime || e.start_time || e.selectedSlot || e.startAt) as string | undefined;
        const status = String(e.appointmentStatus || e.status || "").toLowerCase();
        return { start, status, t: start ? new Date(start).getTime() : NaN };
      })
      .filter((e) => e.start && !Number.isNaN(e.t) && e.t > now && !/cancel|noshow|no_show|invalid/.test(e.status))
      .sort((a, b) => a.t - b.t);
    writeDiag("appt_diag", { contactId, status: res.status, found: list.length, future: future.length, soonest: future[0]?.start ?? null });
    return future[0]?.start ?? null;
  } catch (err) {
    console.error("[ghl] getContactUpcomingAppointment threw:", err);
    return null;
  }
}
