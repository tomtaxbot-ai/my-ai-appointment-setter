/**
 * FOLLOW-UP ENGINE — proactive re-engagement of leads who went quiet. Reuses
 * the proven proactive-send pattern (claim-lock via a unique insert, gated by a
 * flag, enable boundary, guards) so it can't double-send or talk over a live
 * chat. Timing is 100% code-controlled (the AI only writes the words, never
 * decides when). Two buckets, two cadences, all measured from the stall anchor
 * (the lead's last inbound):
 *
 *   Bucket A — ghosted mid-conversation (pre-pitch): 24h, 3d, 7d
 *   Bucket B — cold feet (pitched / sent link, didn't book): 30min, 24h, 3d
 *
 * The asking is proactive (here); the lead's REPLIES flow back through the
 * normal reply pipeline at their existing stage — so follow-ups only ever act
 * in the silence, never alongside a live exchange.
 *
 * SAFETY: dormant unless clients.followup_enabled = true, and it only acts on
 * stalls that happen AFTER followup_enabled_at (no retroactive blasts).
 */
import Anthropic from "@anthropic-ai/sdk";
import { supabase, logEvent, saveMessage, eventExists, type Lead } from "./supabase";
import { sendGHLMessage } from "./ghl";

const STAGES_A = ["opener", "transition_main_reason", "goals", "current_situation", "timeline", "problem"];
const STAGES_B = ["pitch_help", "book"];
const OFFSETS_H = { A: [24, 72, 168], B: [0.5, 24, 72] }; // hours from the stall anchor
const MIN_GAP_H = 20;   // HARD floor: never two follow-ups to the same lead within 20h (kills any "ding-ding-ding")
const MAX_PER_RUN = 25; // global cap per tick — a surge drips over ticks, never blasts

interface FUClient { id: string; enabledAt: number; ghl_api_key: string | null; ghl_location_id: string | null; voice_samples: string | null; business_context: string | null }

async function enabledFollowupClients(): Promise<FUClient[]> {
  const { data } = await supabase.from("clients")
    .select("id, followup_enabled_at, ghl_api_key, ghl_location_id, voice_samples, business_context")
    .eq("followup_enabled", true);
  return (data ?? []).map((c) => {
    const r = c as Record<string, unknown>;
    return {
      id: String(r.id), enabledAt: r.followup_enabled_at ? new Date(String(r.followup_enabled_at)).getTime() : 0,
      ghl_api_key: (r.ghl_api_key as string) ?? null, ghl_location_id: (r.ghl_location_id as string) ?? null,
      voice_samples: (r.voice_samples as string) ?? null, business_context: (r.business_context as string) ?? null,
    };
  });
}

/** Only use the lead's first name if it's clearly a real name (not a handle
 *  like "Don Juba" or "Ali16539"). Otherwise return "" and we skip the name. */
function leadFirstName(lead: Lead): string {
  const fn = (lead.full_name || "").trim();
  if (!fn) return "";
  const first = fn.split(/\s+/)[0] || "";
  if (!/^[a-zA-Z]{2,15}$/.test(first)) return ""; // letters only, sane length
  if (first.toLowerCase() === (lead.ig_username || "").toLowerCase()) return "";
  if (["the", "official", "real", "its", "mr", "coach", "king", "ceo", "team"].includes(first.toLowerCase())) return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Best-effort pull of the lead's stated goal from captured facts. */
function pullGoal(lead: Lead): string {
  const sd = (lead.stage_data || {}) as Record<string, unknown>;
  for (const k of Object.keys(sd)) {
    if (/goal|outcome|dream|income|want|aspir/i.test(k)) {
      const v = sd[k];
      if (typeof v === "string" && v.trim() && v.trim().length < 80) return v.trim();
    }
  }
  return "";
}

/** Generate the one context-aware question for A#1 / B#2. Falls back safely. */
async function genQuestion(client: FUClient, leadId: string, kind: "A1" | "B2"): Promise<string> {
  const fallback = kind === "A1" ? "where did we leave off?" : "wanna lock in a time?";
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return fallback;
    const { data } = await supabase.from("messages").select("role, content").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(8);
    const transcript = ((data ?? []) as { role: string; content: string }[]).reverse()
      .map((m) => `${m.role === "lead" ? "THEM" : "US"}: ${String(m.content || "").slice(0, 200)}`).join("\n");
    const instruction = kind === "A1"
      ? "Write ONE short, casual question that naturally picks this conversation back up from exactly where it stalled (re-ask what we were last discussing). Just the question text."
      : "Write ONE short, casual one-line nudge question that gently moves them toward booking the call, fitting where the conversation ended. Just the question text.";
    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 120, output_config: { effort: "low" },
      system: `You write Instagram DMs in this person's voice. Match their style exactly.\nVOICE SAMPLES:\n${(client.voice_samples || "").slice(0, 1500)}\n\nOutput ONLY the message text — no quotes, no preamble, lowercase casual is fine.`,
      messages: [{ role: "user", content: `Recent thread (oldest first):\n${transcript}\n\n${instruction}` }],
    });
    const txt = res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("").trim();
    return txt ? txt.replace(/^["']|["']$/g, "").slice(0, 200) : fallback;
  } catch {
    return fallback;
  }
}

function buildMessage(bucket: "A" | "B", attempt: number, ctx: { name: string; goal: string; linkSent: boolean; question: string }): string {
  const nameTag = ctx.name ? ` ${ctx.name}` : "";
  const closerGoal = ctx.goal ? `closer to ${ctx.goal}` : "closer to your goals";
  if (bucket === "A") {
    if (attempt === 1) return `yo${nameTag} I'm so sorry bro, I've been so busy but was just going through a few of my convos, so tell me ${ctx.question || "where did we leave off?"}`;
    if (attempt === 2) return `you good bro?`;
    return ctx.goal
      ? `damn, just noticed our convo died out, lmk if ${ctx.goal} is still something you're striving for, feel free to ask any questions, i'm usually pretty active in the dms`
      : `damn, just noticed our convo died out, lmk if you're potentially looking into making money online brotha, feel free to ask any questions, i'm usually pretty active in the dms`;
  }
  // Bucket B
  if (attempt === 1) return ctx.linkSent
    ? `my bad bro, jumped on a quick call but tell me, you got the confirmation email?`
    : `my bad bro, jumped on a quick call but tell me, do you feel like talking to Ethan could help you get ${closerGoal}?`;
  if (attempt === 2) return `just getting back to a few dms brotha, didn't see your name in my system yet so just wanted to reassure you that this is not a "sales call", see it as coaching call #0, worst case you walk away with a plan. ${ctx.question || "wanna lock in a time?"}`;
  // B#3 — hardcoded, ONE single message (sent directly, never burst-split)
  return `hey brother, been trying to reach you a few times these last days to potentially help you get ${closerGoal}\n\nbut didn't hear back from you...\n\nlmk where you want to take it from here?`;
}

/** Mark revival when a lead replied after we'd sent follow-ups (idempotent). */
async function checkRevival(leadId: string, clientId: string, lastLeadAt: string): Promise<void> {
  const { data } = await supabase.from("follow_up_log")
    .update({ revived_at: new Date().toISOString() })
    .eq("lead_id", leadId).is("revived_at", null).lt("sent_at", lastLeadAt).eq("status", "sent")
    .select("id");
  if ((data ?? []).length > 0) {
    await logEvent({ client_id: clientId, lead_id: leadId, event_type: "lead_revived", metadata: { via: "follow_up", count: (data ?? []).length } });
  }
}

/** The whole engine: sweep stalled leads and send any due follow-up. Safe no-op
 *  unless a client has followup_enabled = true. */
export async function runFollowups(): Promise<{ enabled: number; sent: number }> {
  let sent = 0;
  try {
    const clients = await enabledFollowupClients();
    if (!clients.length) return { enabled: 0, sent: 0 };
    const minQuietMs = 25 * 60_000; // smallest cadence is B#1 at 30min — candidates must be quiet ≥25m
    const now = Date.now();

    for (const client of clients) {
      if (!client.ghl_api_key || !client.ghl_location_id) continue;
      const { data: leads } = await supabase.from("leads").select("*")
        .eq("client_id", client.id).eq("status", "engaged")
        .eq("ai_paused", false).eq("followup_paused", false)
        .in("funnel_stage", [...STAGES_A, ...STAGES_B])
        .lt("last_message_at", new Date(now - minQuietMs).toISOString())
        .order("last_message_at", { ascending: true }).limit(60);

      for (const leadRow of (leads ?? []) as Lead[]) {
        try {
          if (sent >= MAX_PER_RUN) break; // global drip cap — never blast
          const lead = leadRow;
          if (!lead.ghl_contact_id) continue;
          const { data: msgs } = await supabase.from("messages").select("role, created_at").eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(12);
          const m = (msgs ?? []) as { role: string; created_at: string }[];
          if (!m.length) continue;

          // Replied since? → revival (and not our job; the reply pipeline owns it).
          if (m[0].role === "lead") { await checkRevival(lead.id, client.id, m[0].created_at); continue; }
          // A HUMAN sent the last message → someone's handling this lead by hand. Stand down.
          if (m[0].role === "human") continue;

          const lastLead = m.find((x) => x.role === "lead");
          if (!lastLead) continue; // never replied to us → manual-outreach bucket (not ours)
          const anchorIso = lastLead.created_at;
          const anchorMs = new Date(anchorIso).getTime();
          if (anchorMs < client.enabledAt) continue; // enable boundary — only stalls after switch-on
          const quietH = (now - anchorMs) / 3_600_000;

          const stage = lead.funnel_stage || "";
          const bucket: "A" | "B" = STAGES_B.includes(stage) ? "B" : "A";
          const offsets = OFFSETS_H[bucket];

          const { data: prior } = await supabase.from("follow_up_log").select("attempt, anchor, sent_at, status").eq("lead_id", lead.id);
          const rows = (prior ?? []) as { attempt: number; anchor: string; sent_at: string | null; status: string }[];
          const attemptsSent = rows.filter((r) => r.anchor === anchorIso).length;
          if (attemptsSent >= 3) continue; // exhausted this stall
          if (quietH < offsets[attemptsSent]) continue; // not due yet
          // HARD anti-burst: never a 2nd follow-up to this lead within MIN_GAP_H,
          // no matter how "overdue" the math says they are. Spaces every touch.
          const lastSentMs = rows.filter((r) => r.status === "sent" && r.sent_at).map((r) => new Date(r.sent_at as string).getTime()).sort((a, b) => b - a)[0];
          if (lastSentMs && now - lastSentMs < MIN_GAP_H * 3_600_000) continue;
          if (await eventExists(lead.id, "appointment_booked")) continue; // already booked → nurture's job

          const attempt = attemptsSent + 1;
          // CLAIM atomically — unique (lead_id, anchor, attempt). Empty insert = another tick owns it.
          const { data: claimed } = await supabase.from("follow_up_log").upsert(
            { client_id: client.id, lead_id: lead.id, ghl_contact_id: lead.ghl_contact_id, bucket, attempt, anchor: anchorIso, stage_at_stall: stage, status: "sending" },
            { onConflict: "lead_id,anchor,attempt", ignoreDuplicates: true }
          ).select("id");
          const row = (claimed ?? [])[0] as { id: string } | undefined;
          if (!row) continue;

          const linkSent = bucket === "B" ? await eventExists(lead.id, "ai_sent_booking_link") : false;
          const needsQ = (bucket === "A" && attempt === 1) || (bucket === "B" && attempt === 2);
          const question = needsQ ? await genQuestion(client, lead.id, bucket === "A" ? "A1" : "B2") : "";
          const text = buildMessage(bucket, attempt, { name: leadFirstName(lead), goal: pullGoal(lead), linkSent, question });

          const res = await sendGHLMessage({ ghl_api_key: client.ghl_api_key, ghl_location_id: client.ghl_location_id, ghl_contact_id: lead.ghl_contact_id, message: text, type: "IG" });
          if (!res.success) {
            await supabase.from("follow_up_log").update({ status: "failed", message: text }).eq("id", row.id);
            continue;
          }
          await supabase.from("follow_up_log").update({ status: "sent", message: text, ghl_message_id: res.ghl_message_id, sent_at: new Date().toISOString() }).eq("id", row.id);
          await saveMessage({ lead_id: lead.id, client_id: client.id, role: "ai", content: text, channel: "instagram", ghl_message_id: res.ghl_message_id, model_used: "followup_engine" });
          await logEvent({ client_id: client.id, lead_id: lead.id, event_type: "follow_up_sent", metadata: { bucket, attempt, stage } });
          sent++;
        } catch (e) {
          console.error("[followups] lead failed:", leadRow.id, e);
        }
      }
      if (sent >= MAX_PER_RUN) break; // cap hit — stop sweeping further clients this tick
    }
    return { enabled: clients.length, sent };
  } catch (err) {
    console.error("[followups] runFollowups failed:", err);
    return { enabled: 0, sent };
  }
}
