/**
 * JARVIS HQ — live pulse. Feeds two visuals on the HQ:
 *   - the data RINGS around the orb (7d funnel + cash, same DB the dashboard uses)
 *   - the incoming RIPPLES (new leads / inbound DMs / bookings since last poll)
 *
 * Polled by the client every ~45s. Cheap: a few indexed counts + the dashboard
 * RPC. No AI involved. Key-gated, read-only.
 *
 * GET /api/hq/pulse?k=<key>&since=<ISO>  →  { now, ring, recent }
 */
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabase } from "@/lib/supabase";
import { getAccessKey } from "@/lib/access";
import { bragCheck } from "@/lib/brag";
import { briefCheck } from "@/lib/brief";
import { flushNurtureDue } from "@/lib/nurture";
import { runFollowups } from "@/lib/followups";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

function pad(n: number) { return String(n).padStart(2, "0"); }
function isoDate(d: Date) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function money(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "$0";
  return "$" + Math.round(v).toLocaleString("en-US");
}

export async function GET(req: NextRequest) {
  try {
    const k = req.nextUrl.searchParams.get("k") ?? "";
    const accessKey = await getAccessKey();
    if (!accessKey || k !== accessKey) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // piggyback: while the HQ is open, Jarvis brags about fresh bookings /
    // payments AND briefs the closer before upcoming calls (after response)
    waitUntil(Promise.all([bragCheck(), briefCheck(), flushNurtureDue(), runFollowups()]));

    // Clamp `since` to the last 10 minutes so a stale tab can't replay history.
    const sinceParam = req.nextUrl.searchParams.get("since") ?? "";
    const floor = Date.now() - 10 * 60_000;
    const sinceMs = Math.max(new Date(sinceParam || 0).getTime() || floor, floor);
    const since = new Date(sinceMs).toISOString();

    const now = new Date();
    const start = isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)));
    const end = isoDate(now);

    const [engaged, dash, newLeads, newBookings, newMsgs, newPays] = await Promise.all([
      supabase.from("leads").select("id", { count: "exact", head: true }).eq("status", "engaged"),
      supabase.rpc("get_dashboard", { p_start: start, p_end: end, p_source: null, p_funnel: "all" }),
      supabase.from("leads").select("created_at").gt("created_at", since).order("created_at", { ascending: true }).limit(20),
      supabase.from("events").select("created_at").in("event_type", ["call_booked", "appointment_booked"])
        .gt("created_at", since).order("created_at", { ascending: true }).limit(10),
      supabase.from("messages").select("created_at").eq("role", "lead")
        .gt("created_at", since).order("created_at", { ascending: true }).limit(20),
      // NEW: cash landing since the last poll — drives the orb's gold flare + the
      // full-screen "deal closed" takeover, with the actual amount.
      supabase.from("payments").select("amount, created_at").gt("created_at", since).order("created_at", { ascending: true }).limit(10),
    ]);

    // Ring numbers come from the SAME get_dashboard RPC the dashboard uses,
    // so the orb never disagrees with the TEU DASHBOARD tab. (Raw table counts
    // diverge: bulk-imported lead rows + the watcher's historical
    // appointment_booked stamps would inflate them.)
    const dashData = dash.data as {
      sales?: { cash_collected?: number; booked?: number };
      by_source?: Array<{ leads?: number }>;
    } | null;
    const sales = dashData?.sales;
    const leads7Count = (dashData?.by_source ?? []).reduce((s, r) => s + (Number(r.leads) || 0), 0);
    const recent: Array<{ t: string; at: string; amount?: number }> = [
      ...(newPays.data ?? []).filter((r) => Number(r.amount) > 0).map((r) => ({ t: "cash", at: r.created_at as string, amount: Number(r.amount) })),
      ...(newBookings.data ?? []).map((r) => ({ t: "booked", at: r.created_at as string })),
      ...(newLeads.data ?? []).map((r) => ({ t: "lead", at: r.created_at as string })),
      ...(newMsgs.data ?? []).map((r) => ({ t: "msg", at: r.created_at as string })),
    ].slice(0, 30);

    return NextResponse.json({
      now: new Date().toISOString(),
      ring: {
        leads7: leads7Count,
        engaged: engaged.count ?? 0,
        booked7: Number(sales?.booked) || 0,
        cash7: money(sales?.cash_collected),
      },
      recent,
    });
  } catch (err) {
    console.error("[hq/pulse] error:", err);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
