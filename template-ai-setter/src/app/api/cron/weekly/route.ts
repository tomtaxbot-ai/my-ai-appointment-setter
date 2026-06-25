/**
 * TRADESMAN WEEKLY DIGEST — Monday morning Telegram drop: new enquiries,
 * jobs booked, reminders sent, review requests sent, and leads going quiet.
 * Built entirely from the events + leads tables (no GHL/customers calls).
 * GET /api/cron/weekly — Vercel cron; optional CRON_SECRET bearer auth.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendTelegramPing } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const now = new Date();
    const startD = new Date(now.getTime() - 7 * 86400_000);
    const startIso = startD.toISOString();
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const [enquiries, booked, remindersSent, reviewsSent, quiet] = await Promise.all([
      supabase.from("leads").select("id", { count: "exact", head: true }).gte("created_at", startIso),
      supabase.from("events").select("id", { count: "exact", head: true }).eq("event_type", "booking_notified").gte("created_at", startIso),
      supabase.from("events").select("id", { count: "exact", head: true }).eq("event_type", "job_reminder_sent").gte("created_at", startIso),
      supabase.from("events").select("id", { count: "exact", head: true }).eq("event_type", "review_requested").gte("created_at", startIso),
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("status", "engaged")
        .eq("ai_paused", false)
        .lt("last_message_at", new Date(now.getTime() - 2 * 86400_000).toISOString()),
    ]);

    const msg = [
      "📊 WEEKLY DIGEST",
      `${iso(startD)} → ${iso(now)}`,
      "",
      `📥 New enquiries: ${enquiries.count ?? 0}`,
      `🔧 Jobs booked: ${booked.count ?? 0}`,
      `⏰ Reminders sent: ${remindersSent.count ?? 0}`,
      `⭐ Review requests sent: ${reviewsSent.count ?? 0}`,
      "",
      `🥶 ${quiet.count ?? 0} engaged leads going quiet 2+ days.`,
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
