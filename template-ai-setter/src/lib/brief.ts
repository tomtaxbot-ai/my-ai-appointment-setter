/**
 * PRE-CALL BRIEFINGS FOR THE CLOSER (Ethan) — Jarvis preps him on Telegram:
 *   - briefCheck(): a deep brief ~30 min before each upcoming call
 *     (piggybacks on the HQ pulse + the daily cron, deduped per appointment)
 *   - dailyCallSheet(): the next 24h of calls with mini-briefs, once a day
 *
 * Recipients come from team_members (active, named Ethan or role ~ closer),
 * using the telegram_chat_id the sales-call logging system already uses.
 */
import { supabase, logEvent, type Lead } from "@/lib/supabase";
import { OWNER_SLUG } from "@/lib/owner";

async function sendTo(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error("[brief] telegram send failed:", err);
  }
}

async function closerChatIds(): Promise<string[]> {
  const { data } = await supabase
    .from("team_members")
    .select("name, role, telegram_chat_id, active")
    .eq("active", true);
  return (data ?? [])
    .filter((m) => m.telegram_chat_id && (/ethan/i.test(String(m.name || "")) || /clos/i.test(String(m.role || ""))))
    .map((m) => String(m.telegram_chat_id));
}

async function leadBriefText(leadId: string | null): Promise<string> {
  if (!leadId) return "No lead record linked to this appointment.";
  const { data: l } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!l) return "No lead record linked to this appointment.";
  const lead = l as Lead & { source?: string };
  const { data: msgs } = await supabase
    .from("messages").select("role, content").eq("lead_id", leadId)
    .order("created_at", { ascending: false }).limit(4);
  const facts = lead.stage_data && Object.keys(lead.stage_data as object).length
    ? Object.entries(lead.stage_data as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")
    : "none logged";
  const last = (msgs ?? []).reverse()
    .map((m) => `${m.role === "lead" ? "THEM" : "US"}: ${String(m.content || "").slice(0, 110)}`)
    .join("\n");
  return [
    `${lead.full_name || lead.ig_username || "?"} (@${lead.ig_username || "?"}) — source: ${lead.source || "?"} · stage: ${lead.funnel_stage || lead.stage || "?"}`,
    `Facts: ${facts}`,
    last ? `Last messages:\n${last}` : "",
  ].filter(Boolean).join("\n");
}

/** Deep brief ~30 min before each call (40-min lookahead window, deduped). */
export async function briefCheck(): Promise<void> {
  try {
    const now = Date.now();
    const { data: calls } = await supabase
      .from("call_reminders")
      .select("ghl_appointment_id, lead_id, call_at")
      .gte("call_at", new Date(now).toISOString())
      .lte("call_at", new Date(now + 40 * 60_000).toISOString());
    if (!calls?.length) return;
    const { data: clientRow } = await supabase.from("clients").select("id").eq("slug", OWNER_SLUG).maybeSingle();
    if (!clientRow) return;
    const { data: sent } = await supabase
      .from("events").select("metadata").eq("event_type", "jarvis_brief")
      .gte("created_at", new Date(now - 24 * 3600_000).toISOString());
    const done = new Set((sent ?? []).map((s) => String((s.metadata as Record<string, unknown> | null)?.ref ?? "")));
    const chats = await closerChatIds();
    if (!chats.length) return;
    for (const call of calls) {
      const ref = `c:${call.ghl_appointment_id}`;
      if (done.has(ref)) continue;
      const mins = Math.max(1, Math.round((new Date(call.call_at).getTime() - now) / 60_000));
      const text = `📞 CALL IN ~${mins} MIN\n\n${await leadBriefText(call.lead_id)}\n\n— Jarvis`;
      for (const chat of chats) await sendTo(chat, text.slice(0, 4000));
      await logEvent({ client_id: clientRow.id, lead_id: call.lead_id ?? undefined, event_type: "jarvis_brief", metadata: { ref } });
    }
  } catch (err) {
    console.error("[brief] check failed:", err);
  }
}

/** The next 24h of calls in one message — the morning call sheet. */
export async function dailyCallSheet(): Promise<void> {
  try {
    const now = new Date();
    const { data: calls } = await supabase
      .from("call_reminders")
      .select("ghl_appointment_id, lead_id, call_at")
      .gte("call_at", now.toISOString())
      .lte("call_at", new Date(now.getTime() + 24 * 3600_000).toISOString())
      .order("call_at");
    if (!calls?.length) return;
    const chats = await closerChatIds();
    if (!chats.length) return;
    const blocks: string[] = [];
    for (const call of calls) {
      const hhmm = new Date(call.call_at).toISOString().slice(11, 16);
      blocks.push(`🕐 ${hhmm} UTC\n${await leadBriefText(call.lead_id)}`);
    }
    const text = `📋 CALL SHEET — next 24h (${calls.length})\n\n${blocks.join("\n\n")}\n\n— Jarvis`;
    for (const chat of chats) await sendTo(chat, text.slice(0, 4000));
  } catch (err) {
    console.error("[brief] call sheet failed:", err);
  }
}
