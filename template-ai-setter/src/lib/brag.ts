/**
 * JARVIS BRAGS IN REAL TIME — new bookings and payments → Telegram ping to
 * Maher, in Jarvis's voice. Deduped via 'jarvis_brag' rows in the events
 * table (metadata.ref = b:<event_id> | p:<payment_id>).
 *
 * Called fire-and-forget from the HQ pulse (near-real-time while the HQ is
 * open) and by the daily catch-up cron (/api/cron/brag).
 */
import { supabase, logEvent } from "@/lib/supabase";
import { sendTelegramPing } from "@/lib/telegram";
import { OWNER_SLUG } from "@/lib/owner";

const LOOKBACK_MS = 45 * 60_000;

export async function bragCheck(): Promise<void> {
  try {
    const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const [booked, pays, brags, clientRow] = await Promise.all([
      supabase.from("events").select("id, lead_id").eq("event_type", "appointment_booked").gte("created_at", sinceIso),
      supabase.from("payments").select("id, amount, customer_id").gte("created_at", sinceIso),
      supabase.from("events").select("metadata").eq("event_type", "jarvis_brag").gte("created_at", new Date(Date.now() - 6 * 3600_000).toISOString()),
      supabase.from("clients").select("id").eq("slug", OWNER_SLUG).maybeSingle(),
    ]);
    const clientId = (clientRow.data as { id: string } | null)?.id;
    if (!clientId) return;
    const done = new Set((brags.data ?? []).map((b) => String((b.metadata as Record<string, unknown> | null)?.ref ?? "")));

    for (const b of booked.data ?? []) {
      if (done.has(`b:${b.id}`)) continue;
      let name = "a new lead";
      if (b.lead_id) {
        const { data: l } = await supabase.from("leads").select("full_name, ig_username").eq("id", b.lead_id).maybeSingle();
        name = l?.full_name || l?.ig_username || name;
      }
      const { count } = await supabase
        .from("reporting_funnel").select("id", { count: "exact", head: true })
        .eq("reached_booked", true).gte("lead_date", new Date(Date.now() - 7 * 86400_000).toISOString());
      await sendTelegramPing(`⚡ Yo — just booked ${name}. That's ${count ?? "another one"} this week. — Jarvis`);
      await logEvent({ client_id: clientId, lead_id: b.lead_id ?? undefined, event_type: "jarvis_brag", metadata: { ref: `b:${b.id}` } });
    }

    for (const p of pays.data ?? []) {
      if (done.has(`p:${p.id}`)) continue;
      let name = "a client";
      if (p.customer_id) {
        const { data: c } = await supabase.from("customers").select("name").eq("id", p.customer_id).maybeSingle();
        name = c?.name || name;
      }
      const amt = Number(p.amount) || 0;
      await sendTelegramPing(`💰 ${name} just paid $${amt.toLocaleString("en-US")}. Cash in. — Jarvis`);
      await logEvent({ client_id: clientId, event_type: "jarvis_brag", metadata: { ref: `p:${p.id}` } });
    }
  } catch (err) {
    console.error("[brag] check failed:", err);
  }
}
