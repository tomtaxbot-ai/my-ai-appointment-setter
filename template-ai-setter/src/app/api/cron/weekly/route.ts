/**
 * JARVIS WEEKLY INTELLIGENCE REPORT — Monday morning Telegram drop: the
 * week's cash, deals (with names), funnel, and what's going cold.
 * GET /api/cron/weekly — Vercel cron; optional CRON_SECRET bearer auth.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendTelegramPing } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const now = new Date();
    const startD = new Date(now.getTime() - 7 * 86400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const [dash, deals, paysRows, cold] = await Promise.all([
      supabase.rpc("get_dashboard", { p_start: iso(startD), p_end: iso(now), p_source: null, p_funnel: "all" }),
      supabase.from("customers").select("name, contract_value, closer, booking_method").gte("closed_at", startD.toISOString()),
      supabase.from("payments").select("amount").gte("collected_at", startD.toISOString()),
      supabase.from("leads").select("id", { count: "exact", head: true })
        .eq("status", "engaged").eq("ai_paused", false)
        .lt("last_message_at", new Date(now.getTime() - 2 * 86400_000).toISOString()),
    ]);
    const d = (dash.data ?? {}) as {
      sales?: { booked?: number; showed?: number; closed?: number; ai_booked?: number; show_rate?: number };
      by_source?: Array<{ leads?: number }>;
    };
    const leads = (d.by_source ?? []).reduce((s, r) => s + (Number(r.leads) || 0), 0);
    const cash = (paysRows.data ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const dealRows = deals.data ?? [];
    const signed = dealRows.reduce((s, c) => s + (Number(c.contract_value) || 0), 0);
    const names = dealRows.map((c) => `${c.name}${c.booking_method === "ai_dm" ? " ⚡" : ""} (${money(Number(c.contract_value) || 0)})`).join(", ") || "none this week";
    const s = d.sales ?? {};
    const msg = [
      "📊 JARVIS WEEKLY REPORT",
      `${iso(startD)} → ${iso(now)}`,
      "",
      `💰 Cash collected: ${money(cash)}`,
      `✍️ Signed: ${money(signed)} — ${dealRows.length} deal${dealRows.length === 1 ? "" : "s"}: ${names}`,
      `📞 Booked: ${s.booked ?? 0} (${s.ai_booked ?? 0} by me ⚡) · Showed: ${s.showed ?? 0} · Closed: ${s.closed ?? 0}`,
      `📥 Leads in: ${leads}`,
      "",
      `🥶 ${cold.count ?? 0} engaged leads going quiet 2+ days — say "who's going cold" in HQ and I'll line up the revival messages.`,
      "",
      "— Jarvis",
    ].join("\n");
    const r = await sendTelegramPing(msg);
    return NextResponse.json({ ok: r.success });
  } catch (err) {
    console.error("[cron/weekly] failed:", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
