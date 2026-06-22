/**
 * ============================================================================
 * ICP SCREENER + LEAD TAGGING
 * ============================================================================
 * This wraps AROUND the existing reply pipeline. It never rewrites the reply
 * logic — the webhook calls into here BEFORE deciding to reply (Part A) and
 * ALONGSIDE the reply (Part B).
 *
 *   PART A — first-contact screener (runs once, when leads.screened = false):
 *     - No prior history        -> engage, tag `icp`, screened = true
 *     - Has prior history       -> fetch full GHL thread, ONE Claude verdict:
 *         engage      -> tag `icp`, continue the reply seamlessly
 *         skip_owner  -> tag `biz owner`, PAUSE, ping Maher, no reply
 *         skip_friend -> tag `friend`,    PAUSE, ping Maher, no reply
 *         hold        -> tag `needs review`, PAUSE, ping Maher, no reply
 *       FAIL-CLOSED: any screener error on a lead WITH history => hold.
 *
 *   PART B — ongoing tagging (each inbound from a screened, non-paused lead):
 *     - qualified (operator's OWN criteria) -> add `qualified` (once)
 *     - biz_owner (established online biz ~$3k+/mo) -> remove `icp`+`qualified`,
 *       add `biz owner`, PAUSE, ping Maher (mid-conversation handoff)
 *     Runs alongside the reply; never blocks it. On error: log + skip.
 *
 * PAUSE ALWAYS MEANS BOTH: leads.ai_paused = true AND the GHL "ai off" tag.
 * GHL lowercases all tags.
 * ============================================================================
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  supabase,
  logEvent,
  eventExists,
  getRecentMessages,
  purgeLead,
  setDisqualifyReason,
  type Client,
  type Lead,
} from "./supabase";
import {
  addContactTags,
  removeContactTags,
  deleteContact,
  fetchContactThread,
  type ThreadMessage,
} from "./ghl";
import { sendTelegramPing, ghlContactLink } from "./telegram";
import { type Message } from "./prompts/master";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  throw new Error("Missing ANTHROPIC_API_KEY in environment variables.");
}
const anthropic = new Anthropic({ apiKey: anthropicKey });

// Lightweight, fast model for classification — must not delay the reply.
export const CLASSIFIER_MODEL = "claude-haiku-4-5";

// GHL tag vocabulary (GHL lowercases everything anyway).
const TAG_ICP = "icp";
const TAG_QUALIFIED = "qualified";
const TAG_BIZ_OWNER = "biz owner";
const TAG_FRIEND = "friend";
const TAG_NEEDS_REVIEW = "needs review";
const TAG_DISQUALIFIED = "disqualified";
const TAG_AI_OFF = "ai off";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Render a message list as a plain transcript for the classifier. */
function transcript(msgs: Array<{ role: string; content: string }>): string {
  return msgs
    .map((m) => `${m.role === "lead" ? "Lead" : "Me"}: ${m.content}`)
    .join("\n");
}

/** Extract the first JSON object from a model response and parse it. */
function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object in response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/** One classifier call. Returns the parsed JSON object (throws on failure). */
async function classify(
  system: string,
  user: string
): Promise<Record<string, unknown>> {
  const resp = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 200,
    system,
    messages: [{ role: "user", content: user }],
  });
  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  return parseJsonObject(raw);
}

function leadName(lead: Lead): string {
  return lead.full_name?.trim() || "Unknown";
}
function leadIg(lead: Lead): string {
  return lead.ig_username?.trim() || "?";
}

/** Mark a lead as screened so the first-contact screener never re-runs. */
async function markScreened(lead: Lead): Promise<void> {
  await supabase
    .from("leads")
    .update({ screened: true })
    .eq("id", lead.id)
    .then(undefined, (err) =>
      console.error("[screener] markScreened failed:", err)
    );
}

/**
 * PAUSE = BOTH sides, so GHL and the engine never disagree:
 *   1. leads.ai_paused = true (Supabase)
 *   2. add the GHL "ai off" tag
 * Both are attempted; either failure is logged but never thrown.
 *
 * ALWAYS pings Maher. pauseLead is the SINGLE choke point for AUTONOMOUS pauses
 * (screener handoffs, disqualifies, stand-bys), so routing the ping here
 * guarantees he's notified 10/10 on every auto pause — including pre-existing
 * contacts — with no duplicate pings. Manual on/off (from Jarvis/Telegram) uses
 * a different code path and stays intentionally silent.
 */
export async function pauseLead(params: {
  client: Client;
  lead: Lead;
  notify?: { label: string; reason?: string };
}): Promise<void> {
  const { client, lead, notify } = params;

  const dbUpdate = supabase
    .from("leads")
    .update({ ai_paused: true })
    .eq("id", lead.id)
    .then(
      ({ error }) => {
        if (error) console.error("[screener] pause: ai_paused update failed:", error);
      },
      (err) => console.error("[screener] pause: ai_paused update threw:", err)
    );

  const tagAdd =
    client.ghl_api_key && lead.ghl_contact_id
      ? addContactTags(client.ghl_api_key, lead.ghl_contact_id, [TAG_AI_OFF]).then(
          (r) => {
            if (!r.success)
              console.error("[screener] pause: 'ai off' tag add failed:", r.error);
          }
        )
      : Promise.resolve(
          console.error("[screener] pause: missing GHL creds, 'ai off' tag NOT added")
        );

  await Promise.all([dbUpdate, tagAdd]);

  // ALWAYS notify Maher (best-effort — never throws into the caller).
  try {
    const label = notify?.label || "AI auto-paused";
    const reasonLine = notify?.reason ? ` - ${notify.reason}` : "";
    const link =
      client.ghl_location_id && lead.ghl_contact_id
        ? `\nOpen: ${ghlContactLink(client.ghl_location_id, lead.ghl_contact_id)}`
        : "";
    await sendTelegramPing(`🔴 ${label}\n${leadName(lead)} (@${leadIg(lead)})${reasonLine}${link}`);
  } catch (err) {
    console.error("[screener] pause ping failed:", err);
  }
}

// ---------------------------------------------------------------------------
// PART A — first-contact screener
// ---------------------------------------------------------------------------

export const SCREENER_SYSTEM_PROMPT = `You are a lead-screening classifier for an Instagram DM setter that books sales calls for an online-income coaching business. We DM new followers a short opener (e.g. "yo brother"), and most threads you see are brand-new leads. You read a DM thread and decide whether the AI setter should ENGAGE the person or hand them off to a human.

Return ONLY strict minified JSON, nothing else, no prose, no code fences:
{"verdict":"engage|skip_owner|skip_friend|hold","reason":"<one line>"}

ENGAGE IS THE DEFAULT. A normal, new, or sparse conversation is a new lead — engage it. This INCLUDES bare greetings and opener exchanges: we said "yo brother", they replied "yo" -> engage. Lack of signal on a fresh thread means new lead -> engage. Absence of signal is NEVER a reason to hold or skip.

Definitions:
- engage (the DEFAULT): use this unless there is CLEAR evidence for one of the categories below. The ICP is anyone who wants to START or GROW online income, from ANY background — a barber who owns a shop but wants online money, someone employed who wants to start, someone who tried online stuff before. Owning a business does NOT disqualify them. Thin/greeting/opener threads with no other signal ALSO engage (new lead).
- skip_owner: ONLY on CLEAR evidence they ALREADY run an established online business at roughly $3k+/month, OR a clear peer relationship (talking shop as equals — "how's the agency going", "how's the coaching going", "hit 10k last month").
- skip_friend: ONLY on CLEAR evidence it is personal with NO prospect framing — banter, personal life, plans to meet up between people who clearly know each other.
- hold: ONLY when there is a GENUINE mixed signal pointing to friend or owner that you truly cannot resolve. NEVER use hold for thin, new, or greeting-only threads — those are engage.

Rules:
- When in doubt, ENGAGE. Skipping or holding requires clear evidence; engaging does not.
- Owning a business does NOT mean skip. Use skip_owner ONLY with clear evidence of an established online business at ~$3k+/mo or a clear peer relationship.
- A bare greeting or one-word reply to our opener is a new lead -> engage, never hold.
- "reason" must be one short line.`;

/**
 * First-message pitch detector. Runs ONLY on brand-new contacts with ZERO
 * prior history. Catches strangers who open by trying to SELL US something
 * (SMMA/agency outreach, "I can get you more clients", web/app/AI-bot builders,
 * paid promo/collab-for-money, lead-gen or signal sellers, etc.). These are
 * erased entirely — no reply, no ping, removed from GHL and the DB.
 *
 * FAIL-SAFE: this can DELETE a contact, so it must fire ONLY on a clear vendor
 * pitch. Anything else — a normal lead, a greeting, a question, a fan, someone
 * who merely mentions they run a business — is NOT a pitch. On any doubt or
 * error the caller falls through to the normal engage path (never deletes).
 */
export const PITCH_SCREENER_SYSTEM_PROMPT = `You classify the FIRST message a stranger sends us on Instagram. We run an online-income coaching business and DM new followers a short opener. Sometimes, instead of a real lead, a stranger cold-DMs us trying to SELL US their own services. Decide if THIS first message is one of those unsolicited sales pitches aimed at us.

Return ONLY strict minified JSON, nothing else, no prose, no code fences:
{"pitch":true|false,"reason":"<one line>"}

Set "pitch":true ONLY when there is CLEAR evidence the sender is a VENDOR soliciting US as their customer. Hallmarks:
- Offering to do work or sell a product/service to us: agency/SMMA outreach, "I can get you more clients/leads/appointments", editing/thumbnails/websites/apps/AI chatbots/automation, SEO, ghostwriting, paid promo or "collab" that means us paying them, lead-gen or "I have a system that…", crypto/forex/trading signal selling.
- The classic shape: a compliment about our page/content, then "I help [people like you] do [result], interested?" or a request to hop on a call to sell us something.

Set "pitch":false for EVERYTHING ELSE — this is the default:
- A normal lead: anyone who wants to START or GROW their own online income, asks how to make money, replies to our opener, asks about our coaching/program/price, or shows interest in what WE offer.
- Bare greetings, one-word replies, questions, fans, compliments with no offer.
- Someone merely mentioning they have a job or run a business — that is NOT pitching us.

When unsure, choose "pitch":false. Deleting a real lead is far worse than letting one spammer through.
- "reason" must be one short line.`;

export interface ScreenerOutcome {
  /** Whether the normal reply pipeline should run after screening. */
  shouldReply: boolean;
  /**
   * Prior thread (oldest-first) to feed into the reply so it continues
   * seamlessly. Only set when the history exists in GHL but not yet in
   * Supabase (avoids duplicating context the reply already has).
   */
  priorHistory?: Message[];
}

/**
 * Run the first-contact screener for a lead whose leads.screened = false.
 * Always marks the lead screened. Returns whether the reply should proceed.
 */
export async function runFirstContactScreener(params: {
  client: Client;
  lead: Lead;
}): Promise<ScreenerOutcome> {
  const { client, lead } = params;
  const apiKey = client.ghl_api_key!;
  const locationId = client.ghl_location_id!;
  const contactId = lead.ghl_contact_id!;

  // --- 1. Pull the GHL thread (the source of truth for prior history). ---
  let thread: ThreadMessage[] | null = null;
  let fetchError: string | null = null;
  try {
    thread = await fetchContactThread(apiKey, locationId, contactId);
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
    console.error("[screener] GHL thread fetch failed:", fetchError);
  }

  // --- 2. How much prior history exists (GHL + Supabase as a cross-check)? ---
  let supaPriorCount = 0;
  try {
    const supaMsgs = await getRecentMessages(lead.id, 50);
    supaPriorCount = Math.max(0, supaMsgs.length - 1); // minus the current inbound
  } catch (e) {
    console.error("[screener] supabase history read failed:", e);
  }
  const ghlHasPrior = thread !== null && thread.length > 1;
  const hasPrior = ghlHasPrior || supaPriorCount > 0;

  // --- 3. FAIL-CLOSED: error while a lead clearly HAS history => hold. ---
  if (fetchError && hasPrior) {
    return actHold(client, lead, "screener error on lead with history", fetchError);
  }

  // --- 4. No prior history => brand-new contact. Before engaging, check whether
  //        the FIRST message is an unsolicited pitch trying to sell US services.
  //        If so, erase them entirely (no reply, no ping, gone from GHL + DB).
  //        Otherwise this is a brand-new lead => engage. ---
  if (!hasPrior) {
    const pitchReason = await detectUnsolicitedPitch(lead);
    if (pitchReason !== null) {
      return actPurgePitch(client, lead, pitchReason);
    }
    // Phase 5: do NOT tag `icp` at hello. A brand-new opener exchange carries
    // no fit signal yet — icp/qualified are applied later by ongoing tagging
    // once the conversation actually shows fit.
    await markScreened(lead);
    await logEvent({
      client_id: client.id,
      lead_id: lead.id,
      event_type: "screen_engage",
      metadata: { reason: "no prior history — brand new lead" },
    });
    return { shouldReply: true };
  }

  // --- 5. Has prior history => ONE Claude classification over the full thread. ---
  const source = thread && thread.length > 0 ? thread : await safeSupaThread(lead.id);
  let verdict: string;
  let reason: string;
  try {
    const out = await classify(SCREENER_SYSTEM_PROMPT, transcript(source));
    verdict = String(out.verdict || "").toLowerCase();
    reason = String(out.reason || "").slice(0, 300);
  } catch (e) {
    // Classifier failed on a lead WITH history => fail closed.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[screener] classification failed:", msg);
    return actHold(client, lead, "classifier error", msg);
  }

  switch (verdict) {
    case "engage": {
      // Phase 5: engaging means "not owner/friend" — it is NOT a fit signal,
      // so we do not tag `icp` here. Ongoing tagging applies icp/qualified once
      // the conversation actually shows intent + financial capacity.
      await markScreened(lead);
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "screen_engage",
        metadata: { reason },
      });
      // Feed GHL history into the reply only if Supabase doesn't already hold it.
      const priorHistory =
        supaPriorCount === 0 && thread && thread.length > 0
          ? threadToMessages(thread)
          : undefined;
      return { shouldReply: true, priorHistory };
    }
    case "skip_owner":
      return actSkipOwner(client, lead, reason);
    case "skip_friend":
      return actSkipFriend(client, lead, reason);
    case "hold":
    default:
      return actHold(client, lead, reason || "unclear", null);
  }
}

// --- Part A action helpers (each: tag + pause + ping + event + screened) ---

async function actSkipOwner(
  client: Client,
  lead: Lead,
  reason: string
): Promise<ScreenerOutcome> {
  await addContactTags(client.ghl_api_key!, lead.ghl_contact_id!, [TAG_BIZ_OWNER]);
  await pauseLead({ client, lead, notify: { label: "Take over - established biz owner", reason } });
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_skip_owner",
    metadata: { reason },
  });
  await markScreened(lead);
  return { shouldReply: false };
}

async function actSkipFriend(
  client: Client,
  lead: Lead,
  reason: string
): Promise<ScreenerOutcome> {
  await addContactTags(client.ghl_api_key!, lead.ghl_contact_id!, [TAG_FRIEND]);
  await pauseLead({ client, lead, notify: { label: "Take over - friend", reason } });
  await setDisqualifyReason(lead.id, "friend_family"); // Phase 6
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_skip_friend",
    metadata: { reason },
  });
  await markScreened(lead);
  return { shouldReply: false };
}

async function actHold(
  client: Client,
  lead: Lead,
  reason: string,
  error: string | null
): Promise<ScreenerOutcome> {
  await addContactTags(client.ghl_api_key!, lead.ghl_contact_id!, [TAG_NEEDS_REVIEW]);
  await pauseLead({ client, lead, notify: { label: "Review - unclear", reason } });
  await logEvent({
    client_id: client.id,
    lead_id: lead.id,
    event_type: "screen_hold",
    metadata: error ? { reason, error } : { reason },
  });
  await markScreened(lead);
  return { shouldReply: false };
}

/**
 * Decide whether a brand-new contact's FIRST message is an unsolicited pitch
 * trying to sell US services. Returns the one-line reason when it clearly is,
 * or null otherwise. FAIL-SAFE by design: a null result means "engage as a
 * normal lead", so on an empty thread, a classifier error, or any ambiguity we
 * return null and NEVER delete the contact.
 */
async function detectUnsolicitedPitch(lead: Lead): Promise<string | null> {
  // The first inbound (plus any burst) is already in Supabase at this point.
  const msgs = await safeSupaThread(lead.id);
  if (msgs.length === 0) return null; // nothing to judge => not a pitch

  try {
    const out = await classify(PITCH_SCREENER_SYSTEM_PROMPT, transcript(msgs));
    if (out.pitch === true) {
      return String(out.reason || "unsolicited service pitch").slice(0, 300);
    }
    return null;
  } catch (e) {
    // Never delete a contact because the classifier failed — fall through to
    // the normal engage path instead.
    console.error("[screener] pitch detection failed (engaging as lead):", e);
    return null;
  }
}

/**
 * Erase an unsolicited pitcher caught at first contact. Per Maher's rule they
 * must "not exist": no reply, no Telegram ping, removed from GHL and the DB.
 * We snapshot a tiny audit record (with lead_id = null, since the lead row is
 * being deleted) so a wrongly-purged real lead can still be traced. Each step
 * is best-effort; failures are logged but never thrown.
 */
async function actPurgePitch(
  client: Client,
  lead: Lead,
  reason: string
): Promise<ScreenerOutcome> {
  const audit = {
    reason,
    ghl_contact_id: lead.ghl_contact_id,
    ig_username: lead.ig_username,
    full_name: lead.full_name,
  };

  // 1. Remove the contact from GHL entirely (best-effort).
  if (client.ghl_api_key && lead.ghl_contact_id) {
    const r = await deleteContact(client.ghl_api_key, lead.ghl_contact_id);
    if (!r.success) {
      console.error("[screener] purge: GHL deleteContact failed:", r.error);
    }
  } else {
    console.error("[screener] purge: missing GHL creds, contact NOT deleted");
  }

  // 2. Remove the lead + its messages/decisions/events from the DB.
  await purgeLead(lead.id);

  // 3. Single audit event (lead is gone, so lead_id is null). No ping, no reply.
  await logEvent({
    client_id: client.id,
    event_type: "screen_purge_pitch",
    metadata: audit,
  });

  console.log("[screener] purged unsolicited pitcher:", JSON.stringify(audit));
  return { shouldReply: false };
}

// ---------------------------------------------------------------------------
// PART B — ongoing tagging (engaged ICP leads only)
// ---------------------------------------------------------------------------

/**
 * Build the Part B system prompt. "qualified" is defined ENTIRELY by the
 * operator's own criteria (their system prompt + business context) — we never
 * invent a new definition.
 */
export function buildOngoingSystemPrompt(client: Client): string {
  const criteria = [client.system_prompt, client.business_context]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("\n\n");

  return `You are a lightweight classifier for an Instagram DM setter. A lead is in an ongoing conversation. Read the WHOLE conversation and decide the fields below. Be CONSERVATIVE — default to the non-committal value. NEVER decide anything off a greeting, a single location, or one trivial reply.

Return ONLY strict minified JSON, nothing else, no prose, no code fences:
{"qualified":bool,"icp":bool,"biz_owner":bool,"disqualify":"none|financial|no_intent","reason":"<one line>"}

- "qualified" (HARD GATE — both must be clearly confirmed in the conversation):
   (1) INTENT: the lead clearly wants to make money online / start or grow online income, AND
   (2) MONEY: the lead has the financial capacity to invest (can afford to pay for help, has income/savings/funds).
   If EITHER is missing or only implied, qualified=false. Never qualified from a greeting, a location, or one trivial answer.
- "icp": a SOFTER "looks like a fit". TRUE when there is REAL signal they fit (clearly wants online income / right profile), even before money is confirmed. Still NEVER true at hello or from a bare greeting/location.
- "biz_owner": TRUE only if it is clear they ALREADY run an established online business at roughly $3k+/month.
- "disqualify": set "financial" ONLY if they clearly state they have no money / cannot invest anything; set "no_intent" ONLY if they clearly do NOT want to make money online (not interested in income at all). Otherwise "none". Be very conservative — do not disqualify off thin or early threads. (Friends/family are handled elsewhere — do not use disqualify for them. Business owners are handed off, never disqualified.)
- "reason": one short line.

Operator's qualification context (supporting signal only — the intent+money gate above is mandatory):
<criteria>
${criteria || "(no explicit criteria provided)"}
</criteria>`;
}

/**
 * Part B: classify an engaged lead's conversation and tag accordingly.
 * Runs alongside the reply; must never block it. On any error: log + skip.
 */
export async function runOngoingTagging(params: {
  client: Client;
  lead: Lead;
}): Promise<void> {
  const { client, lead } = params;
  try {
    const msgs = await getRecentMessages(lead.id, 50);
    if (msgs.length === 0) return;

    const out = await classify(
      buildOngoingSystemPrompt(client),
      transcript(msgs.map((m) => ({ role: m.role, content: m.content })))
    );
    const qualified = out.qualified === true;
    const icp = out.icp === true;
    const bizOwner = out.biz_owner === true;
    const disqualify = String(out.disqualify || "none").toLowerCase();
    const reason = String(out.reason || "").slice(0, 300);

    // biz_owner takes precedence: established online business => handoff (NOT a
    // disqualify; we never set disqualify_reason for owners).
    if (bizOwner) {
      await removeContactTags(client.ghl_api_key!, lead.ghl_contact_id!, [
        TAG_ICP,
        TAG_QUALIFIED,
      ]);
      await addContactTags(client.ghl_api_key!, lead.ghl_contact_id!, [TAG_BIZ_OWNER]);
      await pauseLead({ client, lead, notify: { label: "Take over - established biz owner", reason } });
      await logEvent({
        client_id: client.id,
        lead_id: lead.id,
        event_type: "handoff_biz_owner",
        metadata: { reason },
      });
      return;
    }

    // Phase 6: clear financial / no-intent disqualify => record reason, tag,
    // pause, log (once). Conservative classifier guards against false positives.
    if (disqualify === "financial" || disqualify === "no_intent") {
      const already = await eventExists(lead.id, "lead_disqualified");
      if (!already) {
        await setDisqualifyReason(lead.id, disqualify);
        await addContactTags(client.ghl_api_key!, lead.ghl_contact_id!, [TAG_DISQUALIFIED]);
        await pauseLead({ client, lead, notify: { label: "Disqualified (auto-paused)", reason: `${disqualify} — ${reason}` } });
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "lead_disqualified",
          metadata: { reason: disqualify, note: reason },
        });
      }
      return;
    }

    // Phase 5: `qualified` (hard gate intent+money) and `icp` (softer fit) are
    // SEPARATE tags. Apply each once, keyed off its logged event. Never at hello
    // (the classifier already enforces that).
    if (qualified) {
      const already = await eventExists(lead.id, "tag_qualified");
      if (!already) {
        await addContactTags(client.ghl_api_key!, lead.ghl_contact_id!, [TAG_QUALIFIED]);
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "tag_qualified",
          metadata: { reason },
        });
      }
    }
    if (icp) {
      const already = await eventExists(lead.id, "tag_icp");
      if (!already) {
        await addContactTags(client.ghl_api_key!, lead.ghl_contact_id!, [TAG_ICP]);
        await logEvent({
          client_id: client.id,
          lead_id: lead.id,
          event_type: "tag_icp",
          metadata: { reason },
        });
      }
    }
  } catch (e) {
    // Never let tagging affect the reply path.
    console.error("[screener] ongoing tagging failed:", e);
  }
}

// ---------------------------------------------------------------------------
// internal mappers
// ---------------------------------------------------------------------------

function threadToMessages(thread: ThreadMessage[]): Message[] {
  return thread.map((m) => ({
    role: m.role,
    content: m.content,
    created_at: m.created_at,
  }));
}

/** Fallback transcript source from Supabase if the GHL thread is unavailable. */
async function safeSupaThread(
  lead_id: string
): Promise<Array<{ role: string; content: string }>> {
  try {
    const msgs = await getRecentMessages(lead_id, 50);
    return msgs.map((m) => ({ role: m.role, content: m.content }));
  } catch {
    return [];
  }
}
